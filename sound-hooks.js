/**
 * 声音钩子层：把 PetSound 接到桌宠的真实行为上。
 *
 * 为什么用「原型包装」而不是改 sprite.js / events.js：
 *   sprite.js 有 11 万字符、events.js 2.6 万，直接改内部等于把插件焊死在自己这一版上——
 *   插件一升级，行号和代码全变，补丁必炸。包装原型方法只需要「方法名 + 语义」，
 *   这两样是最稳定的契约；插件升级后重跑一次 apply-sound.ps1 即可，不用再读一遍大文件。
 *
 * 本文件必须在 events.js **之后**加载（此时 PetSprite.prototype 上的
 * showWhisper / showBalanceNow / onClick 等方法才存在），并在 renderer.js 之后
 * 兜一次错误红条（showError 是 renderer.js 里的函数声明）。
 *
 * 接线点（全部来自对运行时源码的实际阅读，不是猜的）：
 *   showWhisper      ← 碎碎念 / 对话回复 / 第三方 broadcast / /bubble/clear 的唯一入口
 *   showBalanceNow   ← 余额气泡（周期轮询与右键「查看余额」共用）
 *   onClick          ← 点击宠物的随机回应（开心/害羞/傲娇）
 *   onPointerMove    ← dragState.dragging 由 false → true 的那一帧 = 真正开始拖拽
 *   onPointerUp      ← 松手：有初速 = 被甩出去；无初速 = 原地放下
 *   startThrow       ← 抛掷开始（标记一次飞行，供落地判定）
 *   startSquash      ← 落地 Q 弹的同一函数；飞行中第一次挤压 = 落地
 *   dispose          ← 配置重载/窗口销毁时停掉朗读
 */
(function () {
  'use strict';

  var PS = window.PetSound;
  var P = typeof PetSprite !== 'undefined' ? PetSprite : null;
  if (!PS || !P) {
    // 宿主没注入引擎（或脚本顺序被改坏了）：安静跳过，绝不让宠物起不来
    try {
      console.warn('[pet-sound] hooks skipped: PetSound=' + !!PS + ' PetSprite=' + !!P);
    } catch (e) {}
    return;
  }

  function wrap(name, factory) {
    var orig = P.prototype[name];
    if (typeof orig !== 'function') return false;
    P.prototype[name] = factory(orig);
    return true;
  }

  // ---------- 气泡：说话 + 弹出音 ----------
  wrap('showWhisper', function (orig) {
    return function (text, image, url, duration, anim) {
      var out = orig.apply(this, arguments);
      try {
        if (typeof text === 'string' && text.length > 0) {
          PS.sfx('bubble');
          // 碎碎念 / 对话 / 第三方广播走的是同一个 say 叶子，运行时区分不出来，
          // 统一按 voice.speakBubble 开关处理（见 sound.jsonc 注释）。
          PS.speak(text, { kind: 'say' });
        }
      } catch (e) {}
      return out;
    };
  });

  // ---------- 余额气泡 ----------
  wrap('showBalanceNow', function (orig) {
    return function (state, manual, tick) {
      var out = orig.apply(this, arguments);
      try {
        PS.sfx('balance');
        var view = this.balanceView;
        if (Array.isArray(view)) {
          var parts = [];
          for (var i = 0; i < view.length; i++) {
            var row = view[i];
            if (row && typeof row.text === 'string' && row.text) parts.push(row.text);
          }
          if (parts.length) PS.speak(parts.join('，'), { kind: 'balance' });
        }
      } catch (e) {}
      return out;
    };
  });

  // ---------- 点击回应 ----------
  wrap('onClick', function (orig) {
    return function (e) {
      var out = orig.apply(this, arguments);
      try {
        PS.sfx('click');
        if (PS.state().config.voice.speakClick) PS.speak('嗯哼', { kind: 'click' });
      } catch (err) {}
      return out;
    };
  });

  // ---------- 拖拽开始（dragState.dragging 只在真正过阈值那一帧置位） ----------
  wrap('onPointerMove', function (orig) {
    return function (e) {
      var dragging = !!(this.dragState && this.dragState.dragging);
      var out = orig.apply(this, arguments);
      try {
        if (dragging && !this.__petSoundDragging) {
          this.__petSoundDragging = true;
          PS.sfx('dragStart');
        }
      } catch (err) {}
      return out;
    };
  });

  // ---------- 松手：甩出去 / 原地放下 ----------
  wrap('onPointerUp', function (orig) {
    return function (e) {
      var wasDragging = !!(this.dragState && this.dragState.dragging);
      var out = orig.apply(this, arguments);
      try {
        if (wasDragging) {
          this.__petSoundDragging = false;
          // startThrow 之后 throwState 非空 = 这次松手抛出去了
          if (this.throwState) {
            PS.sfx('throw');
            this.__petSoundFlying = true;
          } else {
            PS.sfx('drop');
          }
        }
      } catch (err) {}
      return out;
    };
  });

  // ---------- 抛掷开始：重置"本段飞行还没落过地" ----------
  wrap('startThrow', function (orig) {
    return function () {
      try {
        this.__petSoundFlying = true;
        this.__petSoundLanded = false;
      } catch (e) {}
      return orig.apply(this, arguments);
    };
  });

  // ---------- 落地：飞行中第一次挤压 = 落地 Q 弹 ----------
  wrap('startSquash', function (orig) {
    return function () {
      var flying = !!this.__petSoundFlying;
      var out = orig.apply(this, arguments);
      try {
        if (flying && !this.__petSoundLanded) {
          this.__petSoundLanded = true;
          this.__petSoundFlying = false;
          PS.sfx('drop');
        }
      } catch (e) {}
      return out;
    };
  });

  // ---------- 销毁：停朗读 ----------
  wrap('dispose', function (orig) {
    return function () {
      try {
        PS.stop();
      } catch (e) {}
      return orig.apply(this, arguments);
    };
  });

  // ---------- 错误红条（renderer.js 里的函数声明，本文件在它之后加载） ----------
  try {
    if (typeof window.showError === 'function') {
      var origShowError = window.showError;
      window.showError = function (message) {
        try {
          PS.sfx('error');
        } catch (e) {}
        return origShowError.apply(this, arguments);
      };
    }
  } catch (e) {}

  // 把引擎挂到调试面板，方便在控制台里 `__dshPetDebug.sound.selfTest()`
  try {
    window.__dshPetDebug = window.__dshPetDebug || {};
    window.__dshPetDebug.sound = PS;
  } catch (e) {}
})();
