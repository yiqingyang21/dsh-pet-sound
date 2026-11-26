/**
 * dsh-pet 声音系统（桌面助手半侧）—— 纯合成、零外部素材、零网络。
 *
 * 设计目标：给桌宠加"活物感"的声音，并且**绝不拖累渲染**：
 *   - 所有入口都包在 try/catch 里：任何音频错误都只记账（PetSound.state().lastError），
 *     不影响宠物动画、拖拽、气泡；
 *   - 没有 AudioContext 就静音降级，不抛异常；
 *   - 语音有三条路，按配置与探测结果自动选：
 *       1) 系统 TTS（speechSynthesis，Windows 上走 SAPI）——最自然；
 *       2) 宠物电子音（按字发音的 blip，动森式）——TTS 不可用时**保证出声**；
 *       3) 静默。
 *
 * 为什么不用外部音频文件：插件包内没有任何音频素材，桌面助手是纯本地 file:// 页面，
 * 与其新增一堆 wav（体积 + 素材归属 + 打包问题），不如用 Web Audio 现场合成——
 * 音效只有几十行，音色可参数化，且天然跨设备一致。
 *
 * 音效清单（都可在 sound.jsonc 里单独关）：
 *   click 点击回应 / dragStart 开始拖 / drop 落地下沉 / throw 甩出呼啸 /
 *   bubble 气泡弹出 / whisper 碎碎念 / balance 余额金币 / error 出错
 *
 * 配置来源：petBridge.readSoundConfig()（preload 读 $DSH_HOME/dsh-pet/sound.jsonc）。
 * 读不到就用内置默认（见 DEFAULTS），行为等于"全开、中等音量"。
 */
(function () {
  'use strict';

  // ---------------- 默认配置 ----------------
  // 字段全部可选：sound.jsonc 缺什么就用这里的值，非法值也回落到这里（不报错、不阻塞）。
  var DEFAULTS = {
    enabled: true,
    volume: 0.8,
    sfx: {
      enabled: true,
      volume: 1,
      click: true,
      dragStart: true,
      drop: true,
      throw: true,
      bubble: true,
      whisper: true,
      balance: true,
      error: true,
    },
    voice: {
      // auto    = OneCore(Yaoyao) → SAPI(Huihui) → speechSynthesis → 电子音，逐级降级
      // onecore = 只用 OneCore 常驻语音（最甜，默认选 Yaoyao）
      // sapi    = 只用 SAPI（Huihui，播报腔）
      // tts     = 只用 Chromium speechSynthesis（本机 0 个语音）
      // blip    = 只用宠物电子音
      mode: 'auto',
      // OneCore 语音名（模糊匹配）：Yaoyao 年轻女声 / Huihui 成熟女声 / Kangkang 男声
      onecoreVoice: 'Yaoyao',
      // Edge 在线神经语音（最高优先级，零显存）—— 需要 D:\ai\edge\server.py 在跑
      edgeUrl: 'http://127.0.0.1:9881',
      edgeEnabled: true,
      // CosyVoice2 本地服务（离线后备）：无内置音色，靠参考音做零样本迁移
      cosyUrl: 'http://127.0.0.1:9880',
      cosyEnabled: true,
      // 留空 = 纯零样本（音色跟随参考音）；填写则走 instruct 模式（更慢，一般不用）
      cosyInstruct: '',
      enabled: true,
      volume: 0.9,
      rate: 1.02,
      pitch: 1.35,
      lang: 'zh-CN',
      maxChars: 120,
      // 碎碎念 / 对话回复 / 第三方广播共用宿主同一个 say 叶子，运行时无法区分，
      // 所以只给一个开关（见 sound-hooks.js 的 showWhisper 包装）。
      speakBubble: true,
      speakBalance: false,
      speakClick: false,
    },
    log: false,
  };

  // ---------------- 小工具 ----------------
  function isObj(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }
  function num(v, def, min, max) {
    var n = Number(v);
    if (!isFinite(n)) return def;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }
  function bool(v, def) {
    return typeof v === 'boolean' ? v : def;
  }
  function str(v, def) {
    return typeof v === 'string' && v.length > 0 ? v : def;
  }
  /** 深合并：只覆盖默认里存在的键，未知键忽略（免得配置写错了整份失效）。 */
  function merge(base, over) {
    var out = {};
    var k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    if (!isObj(over)) return out;
    for (k in out) {
      if (!Object.prototype.hasOwnProperty.call(out, k)) continue;
      if (isObj(out[k])) {
        if (isObj(over[k])) out[k] = merge(out[k], over[k]);
      } else if (over[k] !== undefined) {
        out[k] = over[k];
      }
    }
    return out;
  }

  // ---------------- 状态 ----------------
  var cfg = merge(DEFAULTS, null);
  var ctx = null; // AudioContext
  var master = null; // 总音量
  var sfxGain = null;
  var voiceGain = null;
  var noiseBuf = null;
  var unlocked = false;
  var ready = false;
  var disposeFns = [];
  var bridgeRef = null;

  /** 把渲染层的真实现场写到 $DSH_HOME/dsh-pet/sound-diag.log（诊断用，失败静默）。 */
  function diag(payload) {
    try {
      if (bridgeRef && typeof bridgeRef.reportDiag === 'function') bridgeRef.reportDiag(payload);
    } catch (e) {}
  }

  var state = {
    lastError: '',
    sfxPlayed: 0,
    spoke: 0,
    blips: 0,
    ttsAvailable: null, // null 未知 / true / false
    ttsFailures: 0,
    ttsDisabledForSession: false,
    sapiOk: null, // SAPI 直连可用性（null 探测中）
    sapiProbe: '',
    ocOk: null, // OneCore 常驻语音（Yaoyao）可用性
    cosyOk: null, // CosyVoice2 本地服务可用性
    edgeOk: null, // Edge 在线神经语音可用性
    edgeVoice: '',
    ocProbing: false,
    ocVoice: '',
    lastVoiceMode: '', // 'onecore' | 'sapi' | 'tts' | 'blip' | 'off'
  };

  function log() {
    if (!cfg.log) return;
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift('[pet-sound]');
      console.log.apply(console, args);
    } catch (e) {}
  }
  function fail(where, e) {
    state.lastError = where + ': ' + (e && e.message ? e.message : String(e));
    log('ERR ' + state.lastError);
  }

  // ---------------- 音频上下文 ----------------
  function ensureContext() {
    if (ctx) return ctx;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) {
        state.lastError = 'AudioContext 不可用';
        return null;
      }
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = cfg.enabled ? cfg.volume : 0;
      master.connect(ctx.destination);

      sfxGain = ctx.createGain();
      sfxGain.gain.value = cfg.sfx.enabled ? cfg.sfx.volume : 0;
      sfxGain.connect(master);

      voiceGain = ctx.createGain();
      voiceGain.gain.value = cfg.voice.volume;
      voiceGain.connect(master);

      // 一段 1 秒白噪声，供"落地/甩出"这类气声采样复用
      var len = Math.floor(ctx.sampleRate * 1);
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

      ready = true;
      log('context ready, rate=' + ctx.sampleRate);
      return ctx;
    } catch (e) {
      fail('ensureContext', e);
      ctx = null;
      return null;
    }
  }

  /**
   * 解锁：Chromium 的自动播放策略要求上下文在用户手势后 resume。
   * 桌宠窗口在"点一下宠物/菜单"之后必然会走到这里；之前的音效会静默丢弃（不排队）。
   */
  function unlock() {
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') {
        ctx.resume().then(function () {
          unlocked = true;
          log('context resumed');
        }).catch(function (e) { fail('resume', e); });
      } else {
        unlocked = true;
      }
    } catch (e) {
      fail('unlock', e);
    }
  }

  // ---------------- 合成基元 ----------------
  function env(gain, t0, attack, hold, release, peak) {
    var g = gain.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(Math.max(0.0001, peak), t0 + attack);
    g.setValueAtTime(Math.max(0.0001, peak), t0 + attack + hold);
    g.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);
    return t0 + attack + hold + release;
  }

  /** 一声正弦/三角"啵"：pitch 从 f0 滑到 f1。 */
  function tone(opts) {
    if (!ctx) return 0;
    var t0 = ctx.currentTime + (opts.delay || 0);
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(opts.f0, t0);
    if (opts.f1 && opts.f1 !== opts.f0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.f1), t0 + (opts.glide || 0.08));
    }
    var peak = opts.peak == null ? 0.25 : opts.peak;
    var dur = env(g, t0, opts.attack || 0.008, opts.hold || 0.02, opts.release || 0.09, peak);
    var dest = opts.dest || sfxGain;
    osc.connect(g);
    g.connect(dest);
    osc.start(t0);
    osc.stop(dur + 0.02);
    osc.onended = function () {
      try {
        osc.disconnect();
        g.disconnect();
      } catch (e) {}
    };
    return dur;
  }

  /** 气声：噪声 + 带通扫频，用来做"落地/甩出"。 */
  function whoosh(opts) {
    if (!ctx || !noiseBuf) return 0;
    var t0 = ctx.currentTime + (opts.delay || 0);
    var src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = opts.q == null ? 1.2 : opts.q;
    bp.frequency.setValueAtTime(opts.fFrom, t0);
    bp.frequency.exponentialRampToValueAtTime(Math.max(20, opts.fTo), t0 + (opts.dur || 0.25));
    var g = ctx.createGain();
    env(g, t0, opts.attack || 0.01, opts.hold || 0.02, opts.release || 0.2, opts.peak == null ? 0.18 : opts.peak);
    src.connect(bp);
    bp.connect(g);
    g.connect(opts.dest || sfxGain);
    src.start(t0);
    src.stop(t0 + (opts.dur || 0.25) + 0.05);
    src.onended = function () {
      try {
        src.disconnect();
        bp.disconnect();
        g.disconnect();
      } catch (e) {}
    };
    return (opts.dur || 0.25) + 0.05;
  }

  // ---------------- 音效配方 ----------------
  // 每个配方尽量短（<350ms），且音量克制——桌宠是长期存在的东西，吵人的音效等于负分。
  var RECIPES = {
    click: function () {
      tone({ type: 'sine', f0: 880, f1: 1380, glide: 0.05, peak: 0.18, hold: 0.01, release: 0.06 });
      tone({ type: 'sine', f0: 1320, f1: 1760, glide: 0.05, peak: 0.08, delay: 0.045, release: 0.07 });
    },
    dragStart: function () {
      tone({ type: 'triangle', f0: 300, f1: 620, glide: 0.09, peak: 0.12, release: 0.08 });
    },
    drop: function () {
      tone({ type: 'sine', f0: 220, f1: 90, glide: 0.12, peak: 0.22, release: 0.12 });
      whoosh({ fFrom: 700, fTo: 180, dur: 0.16, peak: 0.1, release: 0.1 });
    },
    throw: function () {
      whoosh({ fFrom: 400, fTo: 1900, dur: 0.28, peak: 0.13, q: 0.9, release: 0.16 });
    },
    bubble: function () {
      tone({ type: 'sine', f0: 1046, peak: 0.12, release: 0.05 });
      tone({ type: 'sine', f0: 1568, peak: 0.1, delay: 0.06, release: 0.07 });
    },
    whisper: function () {
      tone({ type: 'sine', f0: 1318, f1: 1568, glide: 0.1, peak: 0.09, release: 0.12 });
    },
    balance: function () {
      var notes = [1046, 1318, 1568, 2093];
      for (var i = 0; i < notes.length; i++) {
        tone({ type: 'triangle', f0: notes[i], peak: 0.1, delay: i * 0.055, release: 0.12 });
      }
    },
    error: function () {
      tone({ type: 'square', f0: 330, f1: 180, glide: 0.16, peak: 0.1, release: 0.16 });
    },
  };

  var ALIASES = {
    click: 'click',
    dragStart: 'dragStart',
    drag: 'dragStart',
    drop: 'drop',
    land: 'drop',
    throw: 'throw',
    bubble: 'bubble',
    say: 'bubble',
    whisper: 'whisper',
    balance: 'balance',
    error: 'error',
  };

  // ---------------- 宠物电子音（animalese 式按字发音） ----------------
  /**
   * 为什么需要它：这台机器的 Windows 语音引擎不可用——实测 Electron/Chromium 里
   * speechSynthesis.getVoices() 返回 0 个声音，SAPI5 与 OneCore 两套引擎也都不出声。
   * 于是准备一条纯 Web Audio 的发声路：按字符生成短 blip，用共振峰模拟元音。
   *
   * 音色目标（v2）：像"小声嘟囔着说话"，而不是电子蜂鸣。做法：
   *   - 基频用三角波 + 低八度正弦垫底（去锯齿感，加厚度）
   *   - 两个带通模拟元音共振峰（a/e/i/o/u 轮转）
   *   - 3.5kHz 低通削掉刺耳的高频
   *   - 每字 75ms、字间 18ms，句读延长停顿，句末降调 —— 听感接近"音节"而不是"嘟嘟嘟"
   */
  var BLIP_VOWELS = [
    { f1: 800, f2: 1200 }, // a
    { f1: 500, f2: 1800 }, // e
    { f1: 320, f2: 2200 }, // i
    { f1: 480, f2: 900 }, // o
    { f1: 360, f2: 800 }, // u
  ];

  function blipOne(ch, index, total, opts) {
    if (!ctx) return 0;
    var code = ch.charCodeAt(0);
    if (code < 32) return 0;
    var base = opts.baseHz || 220;
    // 音高：字码 + 句中位置做轻微起伏，避免一条直线
    var semitone = ((code % 9) - 4) * 0.55 + Math.sin(index * 0.9) * 0.8;
    var hz = base * Math.pow(2, semitone / 12);
    // 句末语气下沉、逗号略降 —— 这一条是"像说话"最廉价也最有效的信号
    if (/[。！？!?.~～]/.test(ch)) hz *= 0.78;
    else if (/[，、,；;：:]/.test(ch)) hz *= 0.9;
    hz = Math.max(80, Math.min(700, hz));

    var t0 = ctx.currentTime + (opts.delay || 0);
    var dur = opts.charSec || 0.075;
    var vowel = BLIP_VOWELS[code % BLIP_VOWELS.length];

    // 基频：三角波为主，低八度正弦垫厚度
    var osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(hz, t0);
    osc.frequency.linearRampToValueAtTime(hz * 0.96, t0 + dur);

    var sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(hz / 2, t0);
    var subGain = ctx.createGain();
    subGain.gain.value = 0.35;

    var f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = vowel.f1;
    f1.Q.value = 5;

    var f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = vowel.f2;
    f2.Q.value = 8;

    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3500;
    lp.Q.value = 0.4;

    var g = ctx.createGain();
    env(g, t0, 0.012, dur * 0.5, dur * 0.55, 0.22);

    var mix = ctx.createGain();
    mix.gain.value = 0.55;
    osc.connect(f1);
    osc.connect(f2);
    sub.connect(subGain);
    subGain.connect(f1);
    f1.connect(mix);
    f2.connect(mix);
    mix.connect(lp);
    lp.connect(g);
    g.connect(voiceGain);

    osc.start(t0);
    sub.start(t0);
    osc.stop(t0 + dur + 0.04);
    sub.stop(t0 + dur + 0.04);
    osc.onended = function () {
      try {
        osc.disconnect();
        sub.disconnect();
        subGain.disconnect();
        f1.disconnect();
        f2.disconnect();
        mix.disconnect();
        lp.disconnect();
        g.disconnect();
      } catch (e) {}
    };
    return dur;
  }

  /** 把文本变成一串 blip；返回总时长（秒）。 */
  function blip(text, opts) {
    opts = opts || {};
    if (!ctx) return 0;
    var chars = String(text || '');
    var max = opts.maxChars || cfg.voice.maxChars;
    if (chars.length > max) chars = chars.slice(0, max);
    // 只给"看得见"的字符发音；标点留长短不一的停顿，当作语气
    var total = 0;
    var i = 0;
    var voicePitch = num(opts.pitch, cfg.voice.pitch, 0.5, 2.5);
    var rate = num(opts.rate, cfg.voice.rate, 0.5, 2);
    var baseHz = (opts.baseHz || 220) * voicePitch;
    // 语速：rate 越大字越短；长句再稍微收一点，免得念太久
    var charSec = num(opts.charSec, 0.075 / rate, 0.03, 0.25);
    if (chars.length > 40) charSec *= 0.85;
    var gap = num(opts.gap, 0.018 / rate, 0, 0.12);
    for (i = 0; i < chars.length; i++) {
      var ch = chars.charAt(i);
      if (/[\s\u3000]/.test(ch)) {
        total += gap * 2;
        continue;
      }
      if (/[。！？!?]/.test(ch)) {
        total += gap * 6;
        continue;
      }
      if (/[，、,；;：:]/.test(ch)) {
        total += gap * 3;
        continue;
      }
      blipOne(ch, i, chars.length, { baseHz: baseHz, charSec: charSec, delay: total });
      total += charSec + gap;
    }
    state.blips += 1;
    state.lastVoiceMode = 'blip';
    return total;
  }

  // ---------------- 系统 TTS ----------------
  var ttsQueue = null; // 只在需要时创建
  var currentUtter = null;
  var speakToken = 0;

  function speechApi() {
    try {
      return window.speechSynthesis || null;
    } catch (e) {
      return null;
    }
  }

  /** 探测系统 TTS：没有 API / 没有声音 → false。结果缓存，避免每次朗读都等。 */
  function probeTts(cb) {
    var api = speechApi();
    if (!api) {
      state.ttsAvailable = false;
      cb(false);
      return;
    }
    var cached = null;
    try {
      cached = api.getVoices();
    } catch (e) {
      cached = null;
    }
    if (cached && cached.length > 0) {
      state.ttsAvailable = true;
      cb(true);
      return;
    }
    // 有些环境 voices 是异步就绪的，等一次 voiceschanged；最多 1.2 秒
    var done = false;
    function finish(ok) {
      if (done) return;
      done = true;
      state.ttsAvailable = ok;
      try {
        api.removeEventListener('voiceschanged', onVoices);
      } catch (e) {}
      cb(ok);
    }
    function onVoices() {
      var v = null;
      try {
        v = api.getVoices();
      } catch (e) {}
      finish(!!(v && v.length > 0));
    }
    try {
      api.addEventListener('voiceschanged', onVoices);
    } catch (e) {}
    setTimeout(function () {
      var v = null;
      try {
        v = api.getVoices();
      } catch (e) {}
      finish(!!(v && v.length > 0));
    }, 1200);
  }

  /** 清洗文本：去掉表情/标记/链接，压空白，截断。 */
  function cleanForSpeech(text) {
    var s = String(text || '');
    s = s.replace(/https?:\/\/\S+/g, '');
    s = s.replace(/[*_`#>|]/g, '');
    // 常见 emoji / 符号区（代理对与杂项符号）
    s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '');
    s = s.replace(/\s+/g, ' ').trim();
    var max = cfg.voice.maxChars;
    if (s.length > max) s = s.slice(0, max) + '…';
    return s;
  }

  function pickVoice(api) {
    var voices = [];
    try {
      voices = api.getVoices() || [];
    } catch (e) {}
    var want = String(cfg.voice.lang || 'zh-CN').toLowerCase();
    var i;
    for (i = 0; i < voices.length; i++) {
      if (String(voices[i].lang || '').toLowerCase() === want) return voices[i];
    }
    var prefix = want.split('-')[0];
    for (i = 0; i < voices.length; i++) {
      if (String(voices[i].lang || '').toLowerCase().indexOf(prefix) === 0) return voices[i];
    }
    return null;
  }

  /** 用系统 TTS 朗读；onFail 在"确定没有出声"时调用（由调用方决定是否降级）。 */
  function speakTts(text, onDone, onFail) {
    var api = speechApi();
    if (!api) {
      onFail('no-api');
      return;
    }
    var token = ++speakToken;
    var started = false;
    var settled = false;
    function settle(ok, why) {
      if (settled || token !== speakToken) return;
      settled = true;
      clearTimeout(watchdog);
      if (ok) {
        state.spoke += 1;
        state.lastVoiceMode = 'tts';
        if (state.spoke === 1) diag({ ev: 'tts-ok', text: text.slice(0, 20) });
        onDone && onDone();
      } else {
        state.ttsFailures += 1;
        // 连续失败两次就本会话内不再尝试：避免每条气泡都先卡 1.2 秒再降级
        if (state.ttsFailures >= 2) {
          state.ttsDisabledForSession = true;
          state.ttsAvailable = false;
        }
        log('tts failed: ' + why);
        diag({ ev: 'tts-fail', why: why, failures: state.ttsFailures });
        onFail && onFail(why);
      }
    }

    var u;
    try {
      u = new SpeechSynthesisUtterance(text);
      var v = pickVoice(api);
      if (v) u.voice = v;
      u.lang = cfg.voice.lang;
      u.rate = num(cfg.voice.rate, 1, 0.5, 2);
      u.pitch = num(cfg.voice.pitch, 1, 0.5, 2);
      u.volume = num(cfg.voice.volume, 0.9, 0, 1);
      u.onstart = function () {
        started = true;
      };
      u.onend = function () {
        settle(true);
      };
      u.onerror = function (ev) {
        settle(false, 'error:' + (ev && ev.error ? ev.error : 'unknown'));
      };
    } catch (e) {
      settle(false, 'construct:' + (e && e.message));
      return;
    }

    // 看门狗：1.2 秒还没 onstart，就认为这条不会出声（引擎坏了/被系统静音）
    var watchdog = setTimeout(function () {
      if (!started) {
        try {
          api.cancel();
        } catch (e) {}
        settle(false, 'no-start');
      }
    }, 1200);

    try {
      // 单条朗读：先掐掉上一条，避免气泡连冒时排队积压
      api.cancel();
      currentUtter = u;
      api.speak(u);
    } catch (e) {
      settle(false, 'speak:' + (e && e.message));
    }
  }

  // ---------------- 系统 SAPI 直连（绕开 Chromium） ----------------
  /**
   * 为什么需要这条路：这套 Electron 里 `speechSynthesis.getVoices()` 恒为 0
   * （实测渲染进程里 count=0，而系统 SAPI5 本身是好的，Huihui 中文女声可用）。
   * preload 有完整 Node 能力，于是由 preload 起 PowerShell 调 SAPI 朗读——
   * 这是本机唯一能出"真人声"的路径。
   *
   * 代价：每句要起一个 PowerShell（约 0.3~0.6s 启动），所以只用于整句朗读，
   * 不用于逐字音效。失败时静默，由调用方回落到 speechSynthesis / 电子音。
   */
  function utf8ToBase64(text) {
    try {
      var bytes = new TextEncoder().encode(text);
      var bin = '';
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    } catch (e) {
      try {
        return btoa(unescape(encodeURIComponent(text)));
      } catch (e2) {
        return '';
      }
    }
  }

  /** SAPI 语速档位：-10~10（配置里 rate 是 0.5~2 倍速） */
  function sapiRate() {
    var r = num(cfg.voice.rate, 1, 0.5, 2);
    return Math.max(-10, Math.min(10, Math.round((r - 1) * 8)));
  }

  function sapiVolume() {
    // SAPI 只有 0~100，没有 Web Audio 的总线，所以把两级音量乘进来
    var v = num(cfg.voice.volume, 0.9, 0, 1) * num(cfg.volume, 0.8, 0, 1);
    return Math.max(0, Math.min(100, Math.round(v * 100)));
  }

  function sapiSay(text) {
    if (!bridgeRef || typeof bridgeRef.sapiSay !== 'function') return false;
    var b64 = utf8ToBase64(text);
    if (!b64) return false;
    try {
      return bridgeRef.sapiSay(b64, sapiRate(), sapiVolume()) === true;
    } catch (e) {
      fail('sapiSay', e);
      return false;
    }
  }

  // ---------------- CosyVoice2 本地服务（最高优先级真人声） ----------------
  /**
   * 为什么走 HTTP：桌宠渲染层跑不了 Python，但能 fetch 本机端口。
   * D:\ai\cosy\server.py 常驻模型（约 2.5GB 显存），单句约 2~3 秒合成。
   * 拿回来的 wav 用 Web Audio 播（音量走 voiceGain，和其它引擎一致）。
   */
  var cosySource = null;
  var cosyAbort = null;

  function cosyBase() {
    return String(cfg.voice.cosyUrl || '').replace(/\/+$/, '');
  }

  function stopCosy() {
    try {
      if (cosyAbort) {
        cosyAbort.abort();
        cosyAbort = null;
      }
      if (cosySource) {
        try {
          cosySource.onended = null;
          cosySource.stop();
        } catch (e) {}
        cosySource = null;
      }
    } catch (e) {}
  }

  /** 探测本地服务是否在线（1.5 秒超时，不阻塞其它引擎）。 */
  function probeCosy() {
    if (typeof fetch !== 'function' || typeof AbortController === 'undefined') {
      state.cosyOk = false;
      return;
    }
    if (!cfg.voice.cosyEnabled || !cosyBase()) {
      state.cosyOk = false;
      return;
    }
    var ctrl = null;
    try {
      ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    } catch (e) {}
    var timer = setTimeout(function () {
      try {
        if (ctrl) ctrl.abort();
      } catch (e) {}
    }, 1500);
    fetch(cosyBase() + '/health', ctrl ? { signal: ctrl.signal, cache: 'no-store' } : { cache: 'no-store' })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      })
      .then(function (j) {
        state.cosyOk = !!(j && j.ok);
        diag({ ev: 'cosy-probe', ok: state.cosyOk, model: j && j.model, vram: j && j.vram_mb });
      })
      .catch(function (e) {
        clearTimeout(timer);
        state.cosyOk = false;
        diag({ ev: 'cosy-probe', ok: false, err: String(e && e.message) });
      });
  }

  /** 请求合成并播放；返回 false 表示这次没走成（调用方继续降级）。 */
  function cosySay(text) {
    if (typeof fetch !== 'function' || !state.cosyOk || !cosyBase()) return false;
    ensureContext();
    unlock();
    stopCosy();
    // 掐掉正在念的其它引擎，避免两路声音重叠
    try {
      if (bridgeRef && typeof bridgeRef.ocStop === 'function') bridgeRef.ocStop();
      if (bridgeRef && typeof bridgeRef.sapiStop === 'function') bridgeRef.sapiStop();
    } catch (e) {}

    var ctrl = null;
    try {
      ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    } catch (e) {}
    cosyAbort = ctrl;

    var body = { text: text };
    if (cfg.voice.cosyInstruct) body.instruct = cfg.voice.cosyInstruct;

    fetch(cosyBase() + '/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
      cache: 'no-store',
    })
      .then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) {
        return ctx.decodeAudioData(buf.slice(0));
      })
      .then(function (audioBuf) {
        if (!ctx) return;
        var src = ctx.createBufferSource();
        src.buffer = audioBuf;
        src.connect(voiceGain);
        src.onended = function () {
          if (cosySource === src) cosySource = null;
        };
        cosySource = src;
        src.start(0);
        state.spoke += 1;
        state.lastVoiceMode = 'cosyvoice';
        if (state.spoke === 1) diag({ ev: 'cosy-ok', text: text.slice(0, 20) });
      })
      .catch(function (e) {
        // 主动 aborted 不算失败
        if (e && e.name === 'AbortError') return;
        state.cosyOk = false;
        diag({ ev: 'cosy-err', err: String(e && e.message) });
      });
    return true;
  }

  // ---------------- Edge 神经语音（在线，零显存） ----------------
  /**
   * 为什么加这一层：CosyVoice2 是"克隆参考音"，如果参考音本身是合成音（系统 TTS），
   * 克隆结果会带机械感；而且本地模型占 2.5GB 显存 + 6GB 内存。
   * Edge 是在线神经语音（原生合成、不克隆），音色自然，本地只跑一个 60MB 转发服务。
   * 代价是需要联网；断网时自动降级到 CosyVoice/瑶瑶/电子音。
   */
  var edgeSource = null;
  var edgeAbort = null;

  function edgeBase() {
    return String(cfg.voice.edgeUrl || '').replace(/\/+$/, '');
  }

  function stopEdge() {
    try {
      if (edgeAbort) {
        edgeAbort.abort();
        edgeAbort = null;
      }
      if (edgeSource) {
        try {
          edgeSource.onended = null;
          edgeSource.stop();
        } catch (e) {}
        edgeSource = null;
      }
    } catch (e) {}
  }

  function probeEdge() {
    if (typeof fetch !== 'function' || typeof AbortController === 'undefined') {
      state.edgeOk = false;
      return;
    }
    if (!cfg.voice.edgeEnabled || !edgeBase()) {
      state.edgeOk = false;
      return;
    }
    var ctrl = null;
    try {
      ctrl = new AbortController();
    } catch (e) {}
    var timer = setTimeout(function () {
      try {
        if (ctrl) ctrl.abort();
      } catch (e) {}
    }, 1500);
    fetch(edgeBase() + '/health', ctrl ? { signal: ctrl.signal, cache: 'no-store' } : { cache: 'no-store' })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      })
      .then(function (j) {
        state.edgeOk = !!(j && j.ok);
        state.edgeVoice = (j && j.voice) || '';
        diag({ ev: 'edge-probe', ok: state.edgeOk, voice: state.edgeVoice, pitch: j && j.pitch, rate: j && j.rate });
      })
      .catch(function (e) {
        clearTimeout(timer);
        state.edgeOk = false;
        diag({ ev: 'edge-probe', ok: false, err: String(e && e.message) });
        // 开机时序：DSH 可能比语音服务先起来。失败就每 20 秒重试，最多 30 次（约 10 分钟）。
        state.edgeTries = (state.edgeTries || 0) + 1;
        if (state.edgeTries <= 30) setTimeout(probeEdge, 20000);
      });
  }

  function edgeSay(text) {
    if (typeof fetch !== 'function' || !state.edgeOk || !edgeBase()) return false;
    ensureContext();
    unlock();
    stopEdge();
    // 掐掉其它引擎，避免重叠
    stopCosy();
    try {
      if (bridgeRef && typeof bridgeRef.ocStop === 'function') bridgeRef.ocStop();
      if (bridgeRef && typeof bridgeRef.sapiStop === 'function') bridgeRef.sapiStop();
    } catch (e) {}

    var ctrl = null;
    try {
      ctrl = new AbortController();
    } catch (e) {}
    edgeAbort = ctrl;

    fetch(edgeBase() + '/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text }),
      signal: ctrl ? ctrl.signal : undefined,
      cache: 'no-store',
    })
      .then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) {
        return ctx.decodeAudioData(buf.slice(0));
      })
      .then(function (audioBuf) {
        if (!ctx) return;
        var src = ctx.createBufferSource();
        src.buffer = audioBuf;
        src.connect(voiceGain);
        src.onended = function () {
          if (edgeSource === src) edgeSource = null;
        };
        edgeSource = src;
        src.start(0);
        state.spoke += 1;
        state.lastVoiceMode = 'edge';
        if (state.spoke === 1) diag({ ev: 'edge-ok', text: text.slice(0, 20), voice: state.edgeVoice });
      })
      .catch(function (e) {
        if (e && e.name === 'AbortError') return;
        state.edgeOk = false;
        diag({ ev: 'edge-err', err: String(e && e.message) });
      });
    return true;
  }

  /** 异步探测 OneCore 常驻语音（Yaoyao）。首句慢，所以放在 init 里预热。 */
  function probeOc() {
    if (state.ocProbing) return;
    if (!bridgeRef || typeof bridgeRef.ocStart !== 'function') {
      state.ocOk = false;
      return;
    }
    state.ocProbing = true;
    var ratePct = Math.round(num(cfg.voice.rate, 1, 0.5, 2) * 100);
    // 音调转 SSML pitch（Hz）：配置里的 1.0 = 原调，每 0.1 约 +8Hz
    var pitchHz = Math.round((num(cfg.voice.pitch, 1.15, 0.5, 2.5) - 1) * 80);
    var vol = Math.round(num(cfg.voice.volume, 0.9, 0, 1) * num(cfg.volume, 0.8, 0, 1) * 100);
    var p;
    try {
      p = bridgeRef.ocStart({ voice: cfg.voice.onecoreVoice, ratePct: ratePct, pitchHz: pitchHz, volume: vol });
    } catch (e) {
      state.ocOk = false;
      diag({ ev: 'oc-probe', ok: false, err: String(e && e.message) });
      return;
    }
    Promise.resolve(p)
      .then(function (raw) {
        var s = String(raw || '');
        var ok = s.indexOf('RDY') === 0;
        state.ocOk = ok;
        state.ocVoice = ok ? s.replace(/^RDY\s*/, '') : '';
        state.ocProbing = false;
        diag({
          ev: 'oc-probe',
          ok: ok,
          voice: state.ocVoice,
          ratePct: ratePct,
          pitchHz: pitchHz,
          volume: vol,
          raw: s.slice(0, 200),
        });
      })
      .catch(function (e) {
        state.ocOk = false;
        state.ocProbing = false;
        diag({ ev: 'oc-probe', ok: false, err: String(e && e.message) });
      });
  }

  function ocSay(text) {
    if (!bridgeRef || typeof bridgeRef.ocSpeak !== 'function') return false;
    var b64 = utf8ToBase64(text);
    if (!b64) return false;
    try {
      return bridgeRef.ocSpeak(b64) === true;
    } catch (e) {
      fail('ocSay', e);
      return false;
    }
  }

  /** 异步探测 SAPI（不阻塞渲染）。结果写 state.sapiOk 并记诊断日志。 */
  function probeSapi() {
    if (!bridgeRef || typeof bridgeRef.sapiProbe !== 'function') {
      state.sapiOk = false;
      return;
    }
    var p;
    try {
      p = bridgeRef.sapiProbe();
    } catch (e) {
      state.sapiOk = false;
      diag({ ev: 'sapi-probe', ok: false, err: String(e && e.message) });
      return;
    }
    Promise.resolve(p)
      .then(function (raw) {
        var s = String(raw || '');
        var wav = /WAV\|(\d+)/.exec(s);
        var bytes = wav ? Number(wav[1]) : 0;
        // 判据：能枚举到语音 + 合成出的 WAV 有实质内容（对这台机器的引擎"真活着"最直接的证据）
        var ok = bytes > 1000 && /(Chinese|Huihui|Yaoyao|Kangkang)/i.test(s);
        state.sapiOk = ok;
        state.sapiProbe = s.slice(0, 400);
        diag({ ev: 'sapi-probe', ok: ok, wavBytes: bytes, raw: s.slice(0, 300) });
        log('sapi available=' + ok + ' wav=' + bytes);
      })
      .catch(function (e) {
        state.sapiOk = false;
        diag({ ev: 'sapi-probe', ok: false, err: String(e && e.message) });
      });
  }

  // ---------------- 对外：说话 ----------------
  /**
   * speak(text, opts)
   *   opts.kind: 'whisper' | 'chat' | 'balance' | 'click'（决定该不该出声，见配置）
   *   opts.force: true 跳过 kind 开关
   * 返回实际采用的模式字符串，便于调用方记账/调试。
   */
  function speak(text, opts) {
    opts = opts || {};
    if (!cfg.enabled || !cfg.voice.enabled) return 'off';
    var kind = opts.kind || 'say';
    if (!opts.force) {
      if (kind === 'say' || kind === 'whisper' || kind === 'chat') {
        if (!cfg.voice.speakBubble) return 'off';
      }
      if (kind === 'balance' && !cfg.voice.speakBalance) return 'off';
      if (kind === 'click' && !cfg.voice.speakClick) return 'off';
    }
    var clean = cleanForSpeech(text);
    if (!clean) return 'off';
    ensureContext();
    unlock();

    var mode = cfg.voice.mode;
    if (mode === 'blip') {
      blip(clean);
      return 'blip';
    }
    // 0) Edge 在线神经语音（最自然，零显存）
    if (mode === 'edge' || (mode === 'auto' && state.edgeOk === true)) {
      if (edgeSay(clean)) {
        return 'edge';
      }
      if (mode === 'edge') return 'off';
    }

    // 0.5) CosyVoice2 本地服务（离线后备）
    if (mode === 'cosy' || (mode === 'auto' && state.cosyOk === true)) {
      if (cosySay(clean)) {
        return 'cosyvoice';
      }
      if (mode === 'cosy') return 'off';
    }

    // 1) OneCore 常驻语音（Yaoyao，最甜）
    // 进程可能被 stop() 杀掉过：顺手重新预热，这句先走下一层，下一句就回来了
    if (mode !== 'blip' && state.ocOk === null) probeOc();
    if (mode === 'onecore' || (mode === 'auto' && state.ocOk === true)) {
      if (ocSay(clean)) {
        state.spoke += 1;
        state.lastVoiceMode = 'onecore';
        if (state.spoke === 1) diag({ ev: 'oc-ok', text: clean.slice(0, 20), voice: state.ocVoice });
        return 'onecore';
      }
      if (mode === 'onecore') return 'off';
    }
    // 2) SAPI 直连（Huihui，偏播报腔）
    if (mode === 'sapi' || (mode === 'auto' && state.sapiOk === true)) {
      if (sapiSay(clean)) {
        state.spoke += 1;
        state.lastVoiceMode = 'sapi';
        if (state.spoke === 1) diag({ ev: 'sapi-ok', text: clean.slice(0, 20) });
        return 'sapi';
      }
      if (mode === 'sapi') return 'off';
    }
    if (mode === 'tts') {
      speakTts(clean, null, function () {});
      return 'tts';
    }
    // auto：TTS 优先，失败降级
    if (state.ttsDisabledForSession) {
      blip(clean);
      return 'blip';
    }
    if (state.ttsAvailable === false) {
      blip(clean);
      return 'blip';
    }
    if (state.ttsAvailable === true) {
      speakTts(clean, null, function () {
        blip(clean);
      });
      return 'tts';
    }
    // 未知：先探测（异步）。探测期间先出一声电子音顶上，别让这句话彻底没声；
    // 探测回来若发现 TTS 可用，就把这句改用 TTS 重念一遍（blipped 标记防止叠音）。
    var blipped = false;
    function blipOnce() {
      if (blipped) return;
      blipped = true;
      blip(clean);
    }
    var fallbackBlip = setTimeout(blipOnce, 0);
    probeTts(function (ok) {
      clearTimeout(fallbackBlip);
      // 这一句已经用电子音出过声了：不再补一次 TTS，否则同一句话被念两遍。
      // TTS 可用这件事会记在 state.ttsAvailable 上，从下一句开始生效。
      if (ok && !blipped) {
        speakTts(clean, null, blipOnce);
      } else if (!ok) {
        blipOnce();
      }
    });
    return 'auto';
  }

  // ---------------- 对外：音效 ----------------
  function sfxOne(name) {
    if (!cfg.enabled || !cfg.sfx.enabled) return;
    var key = ALIASES[name] || name;
    if (!RECIPES[key]) return;
    if (cfg.sfx[key] === false) return;
    ensureContext();
    if (!ctx) return;
    unlock();
    try {
      RECIPES[key]();
      state.sfxPlayed += 1;
    } catch (e) {
      fail('sfx:' + key, e);
    }
  }

  // ---------------- 配置应用 ----------------
  function applyConfig() {
    try {
      if (master) master.gain.value = cfg.enabled ? cfg.volume : 0;
      if (sfxGain) sfxGain.gain.value = cfg.sfx.enabled ? cfg.sfx.volume : 0;
      if (voiceGain) voiceGain.gain.value = cfg.voice.volume;
    } catch (e) {
      fail('applyConfig', e);
    }
  }

  function normalize(raw) {
    var m = merge(DEFAULTS, raw);
    var out = {
      enabled: bool(m.enabled, DEFAULTS.enabled),
      volume: num(m.volume, DEFAULTS.volume, 0, 1),
      sfx: {
        enabled: bool(m.sfx.enabled, true),
        volume: num(m.sfx.volume, 1, 0, 1),
        click: bool(m.sfx.click, true),
        dragStart: bool(m.sfx.dragStart, true),
        drop: bool(m.sfx.drop, true),
        throw: bool(m.sfx.throw, true),
        bubble: bool(m.sfx.bubble, true),
        whisper: bool(m.sfx.whisper, true),
        balance: bool(m.sfx.balance, true),
        error: bool(m.sfx.error, true),
      },
      voice: {
        mode: ['auto', 'edge', 'cosy', 'onecore', 'sapi', 'tts', 'blip'].indexOf(String(m.voice.mode)) >= 0 ? String(m.voice.mode) : 'auto',
        onecoreVoice: str(m.voice.onecoreVoice, 'Yaoyao'),
        edgeUrl: str(m.voice.edgeUrl, 'http://127.0.0.1:9881'),
        edgeEnabled: bool(m.voice.edgeEnabled, true),
        cosyUrl: str(m.voice.cosyUrl, 'http://127.0.0.1:9880'),
        cosyEnabled: bool(m.voice.cosyEnabled, true),
        cosyInstruct: typeof m.voice.cosyInstruct === 'string' ? m.voice.cosyInstruct : '',
        enabled: bool(m.voice.enabled, true),
        volume: num(m.voice.volume, 0.9, 0, 1),
        rate: num(m.voice.rate, 1, 0.5, 2),
        pitch: num(m.voice.pitch, 1.15, 0.5, 2.5),
        lang: str(m.voice.lang, 'zh-CN'),
        maxChars: Math.round(num(m.voice.maxChars, 120, 10, 2000)),
        speakBubble: bool(m.voice.speakBubble, true),
        speakBalance: bool(m.voice.speakBalance, false),
        speakClick: bool(m.voice.speakClick, false),
      },
      log: bool(m.log, false),
    };
    return out;
  }

  // ---------------- 初始化 ----------------
  function init() {
    try {
      // 首次交互解锁（桌宠窗口的点击/拖拽/菜单都会经过 window 的 pointerdown）
      var onFirstGesture = function () {
        unlock();
      };
      window.addEventListener('pointerdown', onFirstGesture, true);
      document.addEventListener('keydown', onFirstGesture, true);
      disposeFns.push(function () {
        window.removeEventListener('pointerdown', onFirstGesture, true);
        document.removeEventListener('keydown', onFirstGesture, true);
      });

      // 预创建上下文（真正出声仍要等手势解锁）：让首条音效少一点首次编译的毛刺
      ensureContext();

      // 读配置：没 preload 桥（例如未来在网页端复用）就用默认值
      var bridge =
        window.petSoundBridge && typeof window.petSoundBridge.readSoundConfig === 'function'
          ? window.petSoundBridge
          : window.petBridge;
      bridgeRef = bridge || null;
      probeEdge();
      probeCosy();

      // 把"本窗口能看见什么"写进诊断日志：这是唯一不受外部沙箱污染的证据
      function reportProbe(ok) {
        var api = speechApi();
        var list = [];
        try {
          list = (api && api.getVoices()) || [];
        } catch (e) {}
        var names = [];
        for (var i = 0; i < list.length && i < 10; i++) {
          names.push(String(list[i].name) + '|' + String(list[i].lang));
        }
        diag({
          ev: 'probe',
          available: ok,
          count: list.length,
          voices: names,
          mode: cfg.voice.mode,
          hasApi: !!api,
          contextState: ctx ? ctx.state : 'none',
        });
      }

      if (bridge && typeof bridge.readSoundConfig === 'function') {
        Promise.resolve(bridge.readSoundConfig())
          .then(function (raw) {
            cfg = normalize(raw);
            applyConfig();
            // 真人声两条路并行预热：OneCore（Yaoyao，甜）与 SAPI（Huihui，稳）
            probeOc();
            probeSapi();
            probeTts(function (ok) {
              log('tts available=' + ok + ', cfg=' + JSON.stringify(cfg.voice));
              reportProbe(ok);
            });
          })
          .catch(function (e) {
            fail('readSoundConfig', e);
            probeOc();
            probeSapi();
            probeTts(reportProbe);
          });
      } else {
        probeOc();
        probeSapi();
        probeTts(function (ok) {
          log('no bridge; tts available=' + ok);
          reportProbe(ok);
        });
      }
    } catch (e) {
      fail('init', e);
    }
  }

  /** 立刻停掉正在进行的朗读（配置重载/窗口销毁时用）。 */
  function stop() {
    try {
      speakToken += 1;
      var api = speechApi();
      if (api) api.cancel();
      currentUtter = null;
      // SAPI 是外部 PowerShell 进程，得单独掐
      if (bridgeRef && typeof bridgeRef.sapiStop === 'function') bridgeRef.sapiStop();
      stopEdge();
      stopCosy();
      // OneCore 常驻进程同理：stop 后下次说话会自动重建
      if (bridgeRef && typeof bridgeRef.ocStop === 'function') {
        bridgeRef.ocStop();
        state.ocOk = null; // 进程已杀，下次说话需要重新预热
      }
    } catch (e) {
      fail('stop', e);
    }
  }

  function dispose() {
    stop();
    try {
      var api = speechApi();
      if (api) api.cancel();
    } catch (e) {}
    for (var i = 0; i < disposeFns.length; i++) {
      try {
        disposeFns[i]();
      } catch (e) {}
    }
    disposeFns = [];
    try {
      if (ctx && ctx.close) ctx.close();
    } catch (e) {}
    ctx = null;
    ready = false;
  }

  // ---------------- 暴露 ----------------
  window.PetSound = {
    init: init,
    dispose: dispose,
    sfx: sfxOne,
    speak: speak,
    blip: blip,
    stop: stop,
    unlock: unlock,
    isReady: function () {
      return ready;
    },
    state: function () {
      var s = {};
      for (var k in state) if (Object.prototype.hasOwnProperty.call(state, k)) s[k] = state[k];
      s.contextState = ctx ? ctx.state : 'none';
      s.config = cfg;
      return s;
    },
    /** 自检：给设置页/排障用。会播一小段音效并说一句话。 */
    selfTest: function () {
      ensureContext();
      unlock();
      sfxOne('bubble');
      var mode = speak('声音系统自检，我是大肥鱼', { kind: 'say', force: true });
      return {
        mode: mode,
        sapiOk: state.sapiOk,
        ttsAvailable: state.ttsAvailable,
        contextState: ctx ? ctx.state : 'none',
      };
    },
  };

  // 自动初始化（index.html 里本文件在 sprite.js 之前加载，此时 DOM 还没起来，
  // 但 init 只挂监听 + 异步读配置，不需要 DOM）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();





