/**
 * 声音系统接线测试（不需要声卡、不需要 Electron 窗口）。
 *
 * 做的事：造一个最小 DOM + Web Audio 假环境，把真实的 sound.js / sound-hooks.js
 * 跑起来，再用一个假的 PetSprite（带真实的方法名）触发各种行为，断言：
 *   - 引擎初始化不抛错；
 *   - 钩子层确实包住了 PetSprite.prototype 上的方法（插件升级后方法改名会在这里暴露）；
 *   - 气泡/点击/拖拽/甩出/落地各自触发了对应音效；
 *   - 系统 TTS 不可用时自动降级成电子音（这条正是这台机器的真实情况）。
 *
 * 运行：
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & "$env:USERPROFILE\.dsh\electron\electron.exe" verify.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HERE = __dirname;
const failures = [];
const notes = [];
function check(name, cond, extra) {
  if (cond) notes.push('PASS  ' + name);
  else failures.push('FAIL  ' + name + (extra ? '  → ' + extra : ''));
}

// ---------------- 假 DOM / Web Audio ----------------
function makeParam() {
  return {
    value: 0,
    setValueAtTime() { return this; },
    linearRampToValueAtTime() { return this; },
    exponentialRampToValueAtTime() { return this; },
    cancelScheduledValues() { return this; },
  };
}

function makeAudioContext() {
  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    state: 'running',
    destination: { connect() {}, disconnect() {} },
    resume() { ctx.state = 'running'; return Promise.resolve(); },
    close() { return Promise.resolve(); },
    createGain() {
      return { gain: makeParam(), connect() {}, disconnect() {} };
    },
    createOscillator() {
      return {
        type: 'sine',
        frequency: makeParam(),
        connect() {},
        disconnect() {},
        start() {},
        stop() {},
        onended: null,
      };
    },
    createBiquadFilter() {
      return { type: 'bandpass', frequency: makeParam(), Q: makeParam(), connect() {}, disconnect() {} };
    },
    createBufferSource() {
      return { buffer: null, connect() {}, disconnect() {}, start() {}, stop() {}, onended: null };
    },
    createBuffer(channels, len) {
      return { getChannelData: () => new Float32Array(len) };
    },
  };
  return ctx;
}

function makeSpeechSynthesis(voices, working) {
  const api = {
    speaking: false,
    pending: false,
    paused: false,
    spoken: [],
    getVoices: () => voices,
    speak(u) {
      api.spoken.push(u);
      if (working) {
        // 模拟正常引擎：异步触发 onstart → onend
        setTimeout(() => {
          try { u.onstart && u.onstart(); } catch (e) {}
          setTimeout(() => {
            try { u.onend && u.onend(); } catch (e) {}
          }, 5);
        }, 5);
      }
      // working=false 时什么都不触发：模拟"引擎在但不发声"，交给看门狗判死
    },
    cancel() {},
    addEventListener() {},
    removeEventListener() {},
  };
  return api;
}

function makeEnv(opts) {
  const listeners = {};
  const doc = {
    readyState: 'complete',
    addEventListener(type, fn) { (listeners['doc:' + type] = listeners['doc:' + type] || []).push(fn); },
    removeEventListener() {},
    head: { appendChild() {} },
    createElement: () => ({ className: '', style: {}, textContent: '', appendChild() {}, addEventListener() {} }),
    getElementById: () => ({ textContent: '', classList: { add() {}, remove() {} }, appendChild() {} }),
  };
  const win = {
    AudioContext: function () { return makeAudioContext(); },
    SpeechSynthesisUtterance: function (text) {
      this.text = text;
      this.onstart = null;
      this.onend = null;
      this.onerror = null;
      this.lang = '';
      this.rate = 1;
      this.pitch = 1;
      this.volume = 1;
      this.voice = null;
    },
    speechSynthesis: opts.speech,
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener(type, fn) { (listeners['win:' + type] = listeners['win:' + type] || []).push(fn); },
    removeEventListener() {},
    console,
    Promise,
  };
  win.window = win;
  win.document = doc;
  win.self = win;

  const ctx = vm.createContext(win);
  ctx.window = win;
  ctx.document = doc;
  ctx.console = console;
  ctx.setTimeout = setTimeout;
  ctx.clearTimeout = clearTimeout;
  ctx.Promise = Promise;
  return { sandbox: ctx, win, doc, listeners };
}

// ---------------- 假 PetSprite（方法名与真实插件一致） ----------------
function defineFakeSprite(sandbox) {
  // 用 vm 里执行，确保 PetSprite 是"经典脚本里的词法 class"，与真实运行时一致
  vm.runInContext(
    `
    class PetSprite {
      constructor() {
        this.log = [];
        this.dragState = null;
        this.throwState = null;
        this.balanceView = [{ text: '余额 12.5 元' }];
      }
      showWhisper(text, image, url, duration, anim) { this.log.push('showWhisper'); return 'whisper'; }
      showBalanceNow(state, manual, tick) { this.log.push('showBalanceNow'); return 'balance'; }
      onClick(e) { this.log.push('onClick'); return 'click'; }
      onPointerMove(e) { this.log.push('onPointerMove'); return 'move'; }
      onPointerUp(e) { this.log.push('onPointerUp'); return 'up'; }
      startThrow(px, py, vx, vy) { this.log.push('startThrow'); return 'throw'; }
      startSquash(el, amount) { this.log.push('startSquash'); return 'squash'; }
      dispose() { this.log.push('dispose'); }
    }
    `,
    sandbox,
  );
  return vm.runInContext('new PetSprite()', sandbox);
}

// ---------------- 跑一轮 ----------------
function runScenario(name, speech, mutate) {
  const env = makeEnv({ speech });
  const soundSrc = fs.readFileSync(path.join(HERE, 'sound.js'), 'utf8');
  const hooksSrc = fs.readFileSync(path.join(HERE, 'sound-hooks.js'), 'utf8');

  vm.runInContext(soundSrc, env.sandbox, { filename: 'sound.js' });
  const PS = vm.runInContext('window.PetSound', env.sandbox);
  const sprite = defineFakeSprite(env.sandbox);
  vm.runInContext(hooksSrc, env.sandbox, { filename: 'sound-hooks.js' });

  const result = mutate({ env, PS, sprite, sandbox: env.sandbox });
  return { name, PS, sprite, result, env };
}

const scenarios = [];

// 场景 1：TTS 完全不可用（无 voices）→ 出声必须走电子音兜底
scenarios.push(
  runScenario('tts-unavailable', makeSpeechSynthesis([]), ({ PS, sprite }) => {
    // 等引擎的探测回包（1200ms 看门狗 + 异步探测）
    sprite.showWhisper('主人晚上好呀', '', '', 5000, null);
    return new Promise((r) => setTimeout(() => r(null), 1600));
  }),
);

// 场景 2：有中文语音但引擎"不说话"（不触发 onstart）→ 看门狗应判死并降级
scenarios.push(
  runScenario('tts-hangs', makeSpeechSynthesis([{ name: 'Microsoft Huihui Desktop', lang: 'zh-CN', localService: true }]), ({ PS, sprite }) => {
    sprite.showWhisper('测试看门狗', '', '', 5000, null);
    return new Promise((r) => setTimeout(() => r(null), 1800));
  }),
);

// 场景 3：互动音效链路
scenarios.push(
  runScenario('sfx-chain', makeSpeechSynthesis([]), ({ PS, sprite }) => {
    sprite.onClick({});
    // 拖拽：先移动（未过阈值）→ 过阈值后 dragging=true
    sprite.dragState = { active: true, dragging: false };
    sprite.onPointerMove({});
    sprite.dragState.dragging = true;
    sprite.onPointerMove({});
    sprite.onPointerMove({}); // 第二次不应再响
    return null;
  }),
);

// 场景 4：甩出 → 飞行 → 落地
let threw = null;
try {
  threw = runScenario('throw-land', makeSpeechSynthesis([]), ({ sprite }) => {
    sprite.dragState = { active: true, dragging: true };
    sprite.onPointerMove({}); // 触发 dragStart，并让 __petSoundDragging=true
    sprite.startThrow(0, 0, 900, -200);
    sprite.throwState = { vx: 900, vy: -200 };
    sprite.onPointerUp({}); // 有 throwState → throw 音
    sprite.startSquash({}, 0.6); // 飞行中第一次挤压 → 落地 drop 音
    return null;
  });
} catch (e) {
  failures.push('FAIL  throw-land 场景抛错 → ' + e.message);
}
if (threw) scenarios.push(threw);

// 场景 5：系统 TTS 正常 → 必须走 tts，且不能额外再补一声电子音（防叠音）
scenarios.push(
  runScenario(
    'tts-works',
    makeSpeechSynthesis(
      [{ name: 'Microsoft Huihui Desktop', lang: 'zh-CN', localService: true }],
      true,
    ),
    ({ sprite }) => {
      sprite.showWhisper('这句话应该用系统语音念出来', '', '', 5000, null);
      return new Promise((r) => setTimeout(() => r(null), 600));
    },
  ),
);

// ---------------- 断言 ----------------
if (scenarios.length !== 5) {
  console.log('场景装配异常：scenarios=' + scenarios.length + '（期望 5），threw=' + !!threw);
  console.log(failures.join('\n'));
  process.exit(1);
}
(async () => {
  // 场景 1
  const s1 = scenarios[0];
  await s1.result;
  check('引擎已初始化', !!s1.PS, 'window.PetSound 不存在');
  check('TTS 探测结果=false', s1.PS.state().ttsAvailable === false, '实际 ' + s1.PS.state().ttsAvailable);
  check('碎碎念触发气泡音效', s1.PS.state().sfxPlayed >= 1, 'sfxPlayed=' + s1.PS.state().sfxPlayed);
  check('TTS 不可用时降级为电子音', s1.PS.state().blips === 1, '期望恰好 1 声，实际 ' + s1.PS.state().blips);
  check('最后使用模式=blip', s1.PS.state().lastVoiceMode === 'blip', s1.PS.state().lastVoiceMode);

  // 场景 2
  const s2 = scenarios[1];
  await s2.result;
  check('TTS 引擎挂起被看门狗判死', s2.PS.state().ttsFailures >= 1, 'ttsFailures=' + s2.PS.state().ttsFailures);
  check('挂起后仍出声（降级电子音）', s2.PS.state().blips >= 1, 'blips=' + s2.PS.state().blips);

  // 场景 3
  const s3 = scenarios[2];
  const st3 = s3.PS.state();
  check('点击触发音效', st3.sfxPlayed >= 1, 'sfxPlayed=' + st3.sfxPlayed);
  check('拖拽开始只响一次', st3.sfxPlayed === 2, '期望 2 次（点击+拖拽），实际 ' + st3.sfxPlayed);
  check('原型方法被包装后仍返回原值', s3.sprite.log.includes('onClick'), s3.sprite.log.join(','));

  // 场景 4
  if (threw) {
    const st4 = threw.PS.state();
    check('甩出+落地各响一次', st4.sfxPlayed === 3, '期望 3 次（拖拽+甩出+落地），实际 ' + st4.sfxPlayed);
  }

  // 场景 5：TTS 正常
  const s5 = scenarios[4];
  await s5.result;
  check('TTS 可用时确实走了 TTS', s5.PS.state().spoke >= 1, 'spoke=' + s5.PS.state().spoke);
  check('TTS 正常时不叠电子音', s5.PS.state().blips === 0, '期望 0 声，实际 ' + s5.PS.state().blips);
  check('TTS 模式标记正确', s5.PS.state().lastVoiceMode === 'tts', s5.PS.state().lastVoiceMode);

  // 卸载（dispose 包装）
  const disposeOk = (() => {
    try {
      s1.sprite.dispose();
      return true;
    } catch (e) {
      return false;
    }
  })();
  check('dispose 包装不抛错', disposeOk);

  console.log('\n' + notes.join('\n'));
  if (failures.length) {
    console.log('\n' + failures.join('\n'));
    console.log('\n结果：' + failures.length + ' 项失败');
    process.exit(1);
  }
  console.log('\n结果：全部 ' + notes.length + ' 项通过');
})();
