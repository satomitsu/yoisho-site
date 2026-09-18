// 筋トレ図鑑（atlas.html）。
//
// 種目データは img/atlas/exercise-catalog.json（実体は
// assets/site/atlas/exercise-catalog.json）から読む。60種目に増えても
// このファイルは変えず、データを足すだけで済む形にしてある。
//
// 動画は「配信元（videoBaseUrl）＋視点ごとのキー（views[].videoKey）」で組む。
// **videoBaseUrl が null のあいだは動画を出さない**（静止画のまま「動画は準備中」）。
// 配信先へ置いて再生を確かめてから入れる——入れ替えは1か所で済む（RELEASE.md「筋トレ図鑑」節）。
//
// 出している動画は**いつも1本だけ**。全視点を先読みせず、選んだ視点の分だけ src を張る。
// タブを離れたときと、画面の外へ出たときは止める（戻っただけでは再生しない）。
// 同じ種目のまま視点を替えたときは、再生位置・速度・再生したい意図を次の動画へ引き継ぐ。
// 種目を替えたときは先頭から。
//
// 拡大は指・ホイール・ボタンのどれでもでき、視点を替えても持ち越す。
// **「全画面」はパソコンとスマホで出し方が違う**——パソコンはブラウザの窓の中で
// 広げるだけ、スマホは OS の全画面に出す（本人の指示。2026-09-18）。
(() => {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  // anon キー。公開前提（RLS が唯一の防壁。SECURITY.md）——iOS/Androidアプリの
  // バンドルにも同じ値がそのまま入っている。書き込み先は atlas_feedback だけで、
  // 読み・更新・削除の権限は与えていない（migration 111）
  const SUPABASE_URL = 'https://ojyyixzjiccdmmzpdpwx.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9qeXlpeHpqaWNjZG1tenBkcHd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUwNDc0MTUsImV4cCI6MjEwMDYyMzQxNX0.7iBFdkBmT5AgBZkYnYctNu2hMrEmdB1DIbOnLRE_1bo';

  // 読み込みを待つ上限（これを過ぎたら、押せる状態に戻して知らせる）
  const LOAD_TIMEOUT_MS = 10000;
  // 全画面の返事を待つ上限（過ぎたら自前で広げる）
  const FULLSCREEN_WAIT_MS = 700;

  const REGION_LABELS = {
    chest: '胸', back: '背中', legs: '脚・尻', shoulders: '肩', arms: '腕', core: '腹',
  };

  const state = { exercises: [], videoBase: null, defaultId: null, selected: null, view: null, filter: 'all', query: '', speed: 1 };

  // **読み込みごとの通し番号。** 角度を続けて押すと、前の読み込みの `loadedmetadata` や
  // `play()` の結果が**あとから届いて新しい選択を上書きする**（2026-09-18）。
  // 番号が変わっていたら、届いた結果は捨てる
  let revision = 0;
  // **再生を頼んだ回ごとの番号。** `play()` が却下されるのは非同期なので、
  // 古い却下で新しい動画を止めないよう、こちらでも見分ける
  let playTicket = 0;
  // 読み込み中の目標位置（読み込み中にシークされたらここへ書いて、読めてから当てる）
  let pending = null;
  // **本人が再生したいかどうか。** 動画の paused とは別に持つ——読み込み中は
  // まだ paused なので、これが無いと視点を替えたときに再生が途切れる
  let intendedPlaying = false;

  // 拡大の倍率と、そのときのずらし幅（px）。**視点を替えても持ち越す**
  // ——同じところを別の方向から見比べるためのもの。種目を替えたら戻す
  const zoom = { scale: 1, x: 0, y: 0 };
  const MAX_ZOOM = 4;
  // 全画面の返事を待っているあいだの控え（畳んだら取り消す）
  let fullscreenTimer = null;

  function normalize(value) {
    return value.normalize('NFKC').toLowerCase().replace(/[\s・ー]/g, '');
  }

  function categoryLabel(exercise) {
    return exercise.regions.map((r) => REGION_LABELS[r] || r).join('・');
  }

  function selectedExercise() {
    return state.exercises.find((e) => e.id === state.selected) || state.exercises[0];
  }

  function currentView(item) {
    return item.views.find((v) => v.id === state.view) || item.views[0];
  }

  // 配信元が決まっていない視点は「動画なし」として扱う（架空のURLを張らない）
  function videoUrl(view) {
    if (view.video) return view.video;
    if (state.videoBase && view.videoKey) return state.videoBase + view.videoKey;
    return null;
  }

  function viewSeconds(item, view) {
    const video = $('#atlas-video');
    if (video.duration && Number.isFinite(video.duration) && !video.hidden) return video.duration;
    return view.durationSeconds || item.referenceCycleSeconds || 0;
  }

  function showMessage(text, retry) {
    $('#atlas-message-text').textContent = text || '';
    $('#atlas-retry').hidden = !retry;
    $('#atlas-message').classList.toggle('is-shown', Boolean(text));
  }

  // ---- 拡大縮小（指でひろげる・つまむ／⌘・Ctrl＋ホイール／＋−のボタン）と全画面

  function clampZoom() {
    zoom.scale = Math.min(MAX_ZOOM, Math.max(1, zoom.scale));
    const box = $('.atlas-stage').getBoundingClientRect();
    // **枠の外まで送らない**（送れると、絵の無いところを見ることになる）
    const maxX = (box.width * (zoom.scale - 1)) / 2;
    const maxY = (box.height * (zoom.scale - 1)) / 2;
    zoom.x = Math.min(maxX, Math.max(-maxX, zoom.x));
    zoom.y = Math.min(maxY, Math.max(-maxY, zoom.y));
  }

  function applyZoom() {
    clampZoom();
    $('#atlas-media').style.transform =
      'translate(' + zoom.x + 'px, ' + zoom.y + 'px) scale(' + zoom.scale + ')';
    const stage = $('.atlas-stage');
    // **拡大しているあいだだけ指の動きをこちらで受ける**
    // （等倍のままなら、なぞってページを送れる側に返す）
    stage.style.touchAction = zoom.scale > 1 ? 'none' : '';
    stage.style.cursor = zoom.scale > 1 ? 'grab' : '';
    $('#atlas-zoom-out').disabled = zoom.scale <= 1;
    $('#atlas-zoom-in').disabled = zoom.scale >= MAX_ZOOM;
  }

  function resetZoom() {
    zoom.scale = 1;
    zoom.x = 0;
    zoom.y = 0;
    applyZoom();
  }

  /** `at`（枠の中心から測った位置）を動かさないまま倍率を変える */
  function zoomTo(scale, at) {
    const next = Math.min(MAX_ZOOM, Math.max(1, scale));
    const point = at || { x: 0, y: 0 };
    const ratio = next / zoom.scale;
    zoom.x = point.x - (point.x - zoom.x) * ratio;
    zoom.y = point.y - (point.y - zoom.y) * ratio;
    zoom.scale = next;
    if (next === 1) { zoom.x = 0; zoom.y = 0; }
    applyZoom();
  }

  function stagePoint(clientX, clientY) {
    const box = $('.atlas-stage').getBoundingClientRect();
    return { x: clientX - box.left - box.width / 2, y: clientY - box.top - box.height / 2 };
  }

  function fullscreenNow() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  /** 指で触る端末か（スマホ・タブレット）。パソコンのブラウザと出し方を変える */
  function isHandheld() {
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  }

  /** ブラウザの中で、窓いっぱいに広げる（OS の全画面には持っていかない） */
  function spreadInPage(on) {
    // **待っていた返事はもう要らない**（残すと、畳んだ直後に広げ直してしまう）
    window.clearTimeout(fullscreenTimer);
    fullscreenTimer = null;
    $('.atlas-viewer').classList.toggle('is-full', on);
    document.body.classList.toggle('atlas-full', on);
    onFullscreenChange();
  }

  function toggleFullscreen() {
    const box = $('.atlas-viewer');
    const video = $('#atlas-video');
    window.clearTimeout(fullscreenTimer);
    fullscreenTimer = null;
    if (fullscreenNow()) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      return;
    }
    if (box.classList.contains('is-full')) { spreadInPage(false); return; }

    // **パソコンのブラウザでは、ブラウザの中で広げるだけにする**
    // （本人の指示。2026-09-18。OS の全画面へ持っていかない——
    // タブもアドレスバーも消えると、見ているページから離れた感じになる）
    if (!isHandheld()) { spreadInPage(true); return; }

    // **スマホは OS の全画面へ。** 押しても何も起きない状態を作らないよう、
    // 断られたら次の手に移る: iPhone は動画そのもの → 枠ごと → 自前で広げる
    const fallback = () => {
      if (fullscreenNow() || box.classList.contains('is-full')) return;
      spreadInPage(true);
    };
    if (!video.hidden && video.webkitEnterFullscreen) {
      // iPhone の Safari は要素を全画面にできない。動画そのものを OS の全画面で開く
      try { video.webkitEnterFullscreen(); return; } catch (err) { /* 下へ */ }
    }
    // **返事が来ないこともある**（全画面を断る設定・裏に回った窓）。
    // 少し待って何も起きていなければ、自前で広げる
    fullscreenTimer = window.setTimeout(fallback, FULLSCREEN_WAIT_MS);
    if (box.requestFullscreen) { box.requestFullscreen().catch(fallback); return; }
    if (box.webkitRequestFullscreen) { box.webkitRequestFullscreen(); return; }
    fallback();
  }

  function onFullscreenChange() {
    // 本物の全画面になったなら、自前で広げていたぶんは畳む（二重に効かせない）
    if (fullscreenNow() && $('.atlas-viewer').classList.contains('is-full')) {
      $('.atlas-viewer').classList.remove('is-full');
      document.body.classList.remove('atlas-full');
    }
    const on = Boolean(fullscreenNow()) || $('.atlas-viewer').classList.contains('is-full');
    $('#atlas-full').setAttribute('aria-label', on ? '全画面をやめる' : '全画面で見る');
    $('#atlas-full').textContent = on ? '⤡' : '⤢';
    applyZoom();   // 枠の大きさが変わるので、送り幅を測り直す
  }

  function wireZoom() {
    const stage = $('.atlas-stage');

    $('#atlas-zoom-in').addEventListener('click', () => zoomTo(zoom.scale * 1.5));
    $('#atlas-zoom-out').addEventListener('click', () => zoomTo(zoom.scale / 1.5));
    $('#atlas-full').addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    window.addEventListener('resize', applyZoom);
    // 自前で広げているときは、Esc でも戻れるようにする（本物の全画面と同じ触り心地）
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && $('.atlas-viewer').classList.contains('is-full')) spreadInPage(false);
    });

    // ⌘・Ctrl ＋ホイール（トラックパッドのつまみもこれで届く）。
    // **素のホイールは取らない**——ページが送れなくなる
    stage.addEventListener('wheel', (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const step = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      zoomTo(zoom.scale * step, stagePoint(event.clientX, event.clientY));
    }, { passive: false });

    stage.addEventListener('dblclick', (event) => {
      if (event.target.closest('.atlas-stage-tools')) return;
      if (zoom.scale > 1) resetZoom();
      else zoomTo(2, stagePoint(event.clientX, event.clientY));
    });

    // Safari は2本指を `gesture*` で知らせる。**両方で受けると倍に効く**ので、
    // あるほうだけを使う
    const hasGesture = 'ongesturestart' in window;
    let pinchFrom = 1;
    if (hasGesture) {
      stage.addEventListener('gesturestart', (event) => {
        event.preventDefault();
        pinchFrom = zoom.scale;
      }, { passive: false });
      stage.addEventListener('gesturechange', (event) => {
        event.preventDefault();
        zoomTo(pinchFrom * event.scale);
      }, { passive: false });
      stage.addEventListener('gestureend', (event) => event.preventDefault(), { passive: false });
    }

    let touch = null;
    const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const middle = (t) => stagePoint((t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2);
    stage.addEventListener('touchstart', (event) => {
      const t = Array.from(event.touches);
      if (t.length === 2 && !hasGesture) {
        touch = { kind: 'pinch', from: spread(t), scale: zoom.scale, at: middle(t) };
      } else if (t.length === 1 && zoom.scale > 1) {
        touch = { kind: 'pan', x: t[0].clientX, y: t[0].clientY };
      } else {
        touch = null;
      }
    }, { passive: true });
    stage.addEventListener('touchmove', (event) => {
      if (!touch) return;
      const t = Array.from(event.touches);
      if (touch.kind === 'pinch' && t.length === 2) {
        event.preventDefault();
        zoomTo(touch.scale * (spread(t) / touch.from), touch.at);
      } else if (touch.kind === 'pan' && t.length === 1) {
        event.preventDefault();
        zoom.x += t[0].clientX - touch.x;
        zoom.y += t[0].clientY - touch.y;
        touch.x = t[0].clientX;
        touch.y = t[0].clientY;
        applyZoom();
      }
    }, { passive: false });
    ['touchend', 'touchcancel'].forEach((name) =>
      stage.addEventListener(name, () => { touch = null; }));

    // 指以外（マウス・ペン）は、拡大しているときだけ掴んで動かせる
    let drag = null;
    stage.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'touch' || zoom.scale <= 1) return;
      if (event.target.closest('.atlas-stage-tools')) return;
      drag = { x: event.clientX, y: event.clientY };
      stage.setPointerCapture(event.pointerId);
      stage.style.cursor = 'grabbing';
    });
    stage.addEventListener('pointermove', (event) => {
      if (!drag) return;
      zoom.x += event.clientX - drag.x;
      zoom.y += event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      applyZoom();
    });
    ['pointerup', 'pointercancel'].forEach((name) =>
      stage.addEventListener(name, () => { drag = null; applyZoom(); }));
  }

  // ---- 再生（1本だけ。読み込み中も押せるものと押せないものを見た目に合わせる）

  function updateTransport() {
    const item = selectedExercise();
    if (!item) return;
    const view = currentView(item);
    const hasVideo = Boolean(videoUrl(view));
    const video = $('#atlas-video');
    const play = $('#atlas-play');
    const scrub = $('#atlas-scrub');

    play.disabled = !hasVideo || Boolean(pending);
    scrub.disabled = !hasVideo || Boolean(pending);
    $('#atlas-speed').disabled = !hasVideo;

    if (!hasVideo) {
      $('#atlas-play-symbol').textContent = '▶';
      $('#atlas-play-text').textContent = '動画は準備中';
      play.setAttribute('aria-label', 'この種目の動画は準備中です');
      $('#atlas-time').textContent = '';
      scrub.value = '0';
      return;
    }
    if (pending) {
      $('#atlas-play-symbol').textContent = '…';
      $('#atlas-play-text').textContent = '読込中';
      play.setAttribute('aria-label', '動画を読み込み中');
    } else if (intendedPlaying) {
      $('#atlas-play-symbol').textContent = 'Ⅱ';
      $('#atlas-play-text').textContent = '停止';
      play.setAttribute('aria-label', '動画を停止');
    } else {
      $('#atlas-play-symbol').textContent = '▶';
      $('#atlas-play-text').textContent = '再生';
      play.setAttribute('aria-label', '動画を再生');
    }

    const total = viewSeconds(item, view);
    const at = pending ? pending.time : video.currentTime || 0;
    $('#atlas-time').textContent = at.toFixed(1) + ' / ' + total.toFixed(1) + '秒';
    scrub.value = String(total > 0 ? Math.round((at / total) * 1000) : 0);
    scrub.setAttribute('aria-valuetext', at.toFixed(1) + '秒');
  }

  function playCurrent() {
    const video = $('#atlas-video');
    const version = revision;
    const ticket = ++playTicket;
    intendedPlaying = true;
    video.play().catch(() => {
      // **古い `play()` の却下で、いま選んでいる動画を止めない**
      if (version !== revision || ticket !== playTicket || !intendedPlaying) return;
      intendedPlaying = false;
      updateTransport();
    });
    updateTransport();
  }

  function pauseCurrent() {
    intendedPlaying = false;
    playTicket += 1;
    $('#atlas-video').pause();
    updateTransport();
  }

  // 動画（あれば）と静止画（無ければ）を出す。
  // `reset` は種目を替えたとき——先頭から・停止した状態で始める
  function loadStage(reset) {
    const item = selectedExercise();
    if (!item) return;
    const view = currentView(item);
    state.view = view.id;

    const img = $('#atlas-image');
    const video = $('#atlas-video');
    const url = videoUrl(view);

    const carryTime = reset ? 0 : (pending ? pending.time : video.currentTime || 0);
    if (reset) {
      intendedPlaying = false;
      resetZoom();   // 種目が変われば見ていた場所も変わる（視点を替えたときは持ち越す）
    }

    $('#atlas-stage-badge').textContent = url ? '動画' : '静止画';
    $('.atlas-stage').classList.toggle('has-video', Boolean(url));
    showMessage('');

    if (url) {
      const version = ++revision;
      playTicket += 1;
      img.hidden = true;
      video.hidden = false;
      // **最初はポスターを出して、再生は手で押してもらう**（勝手に鳴らさない）。
      // 取りに行くのは長さを読むぶんだけ（`preload="metadata"`。中身は押されてから）
      video.poster = view.poster;
      video.setAttribute('aria-label', item.name + 'の動作・カメラ ' + view.label + '（音はありません）');
      video.pause();
      pending = { time: carryTime };
      video.src = url;
      // **絶対URLに直してから控える**（`currentSrc` は絶対で返ってくるので、
      // 相対のまま比べると毎回「別物」になり、読み終わりを取りこぼす）
      const expected = video.src;
      video.load();
      // **読み込みが返ってこないときにも、押せる状態へ戻す**（`error` が来ない止まり方がある。
      // 裏へ回っているあいだは OS が読み込みを止めるので、そのときは待ち続ける）
      window.setTimeout(() => {
        if (version !== revision || !pending || document.hidden) return;
        pending = null;
        showMessage('動画を読み込めませんでした。通信を確かめて、もう一度お試しください。', true);
        updateTransport();
      }, LOAD_TIMEOUT_MS);
      video.addEventListener('loadedmetadata', function onLoaded() {
        video.removeEventListener('loadedmetadata', onLoaded);
        // 新しい選択に追い越されていたら捨てる（`currentSrc` も見る——
        // 同じ視点を押し直したときに、番号だけでは見分けられない）
        if (version !== revision || video.currentSrc !== expected || video.readyState < 1) return;
        const target = pending ? pending.time : 0;
        pending = null;
        video.currentTime = Math.min(target, video.duration || 0);
        video.playbackRate = state.speed;
        if (intendedPlaying) playCurrent();
        updateTransport();
      });
    } else {
      revision += 1;
      playTicket += 1;
      pending = null;
      intendedPlaying = false;
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.hidden = true;
      img.hidden = false;
      img.src = view.poster;
      img.alt = item.name + 'の筋肉と姿勢・' + view.label;
    }

    // **角度は撮影座標系のまま**（0°を「正面」と言い換えない）
    $('#atlas-view-label').textContent = 'カメラ ' + view.label;
    $$('#atlas-view-options button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.view === view.id));
    });
    updateTransport();
  }

  // ---- 種目の説明

  function renderDetail(reset) {
    const item = selectedExercise();
    if (!item) return;
    $('#atlas-category').textContent = categoryLabel(item);
    $('#atlas-equipment').textContent = item.equipment ? '・' + item.equipment : '';
    $('#atlas-exercise-title').textContent = item.name;
    $('#atlas-exercise-variant').textContent = item.variant || '';
    $('#atlas-description').textContent = item.description || '';
    $('#atlas-description').hidden = !item.description;
    // 見るポイントは書いてある種目にだけ出す（無いのに「準備中」と置かない）
    $('#atlas-point').textContent = item.point || '';
    $('#atlas-point').closest('.atlas-focus').hidden = !item.point;
    $('#atlas-stable').textContent = item.stableLabel || '';
    $('#atlas-stable').hidden = !item.stableLabel;
    resetFeedbackForm();

    for (const role of ['primary', 'assist']) {
      const ul = $('#atlas-' + role);
      const values = item[role] || [];
      ul.replaceChildren(
        ...values.map((text) => {
          const li = document.createElement('li');
          li.className = 'chip';
          li.textContent = text;
          return li;
        }),
      );
      ul.closest('.atlas-muscle-group').hidden = values.length === 0;
    }

    const options = $('#atlas-view-options');
    options.replaceChildren(
      ...item.views.map((view) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn';
        b.dataset.view = view.id;
        b.textContent = view.label;
        b.setAttribute('aria-pressed', String(view.id === state.view));
        b.addEventListener('click', () => {
          // **同じ視点を押しただけでは読み直さない**（再生が途切れる）
          if (state.view === view.id) return;
          state.view = view.id;
          loadStage(false);
          $('#atlas-announcement').textContent = item.name + 'を' + view.label + 'から表示';
        });
        return b;
      }),
    );

    loadStage(reset);
    renderCards();
  }

  function matches(item, needle) {
    const haystack = [item.name, categoryLabel(item), ...(item.primary || []),
      ...(item.assist || []), ...(item.keywords || [])].join(' ');
    return normalize(haystack).includes(needle);
  }

  function renderCards() {
    const needle = normalize(state.query);
    const items = state.exercises.filter(
      (e) => (state.filter === 'all' || e.regions.includes(state.filter)) && matches(e, needle),
    );
    $('#atlas-result-count').textContent = items.length + '種目';
    $('#atlas-empty').hidden = items.length > 0;

    $('#atlas-cards').replaceChildren(
      ...items.map((item) => {
        const view = item.views[0];
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'atlas-exercise-card';
        card.setAttribute('aria-pressed', String(item.id === state.selected));
        card.setAttribute('aria-label', item.name + 'の詳細を見る');

        const imageBox = document.createElement('div');
        imageBox.className = 'atlas-card-image';
        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = view.poster;
        const viewCount = document.createElement('span');
        viewCount.className = 'chip atlas-card-view';
        // **数はデータから出す**（5方向に決め打ちしない）
        viewCount.textContent = item.views.length + '方向';
        imageBox.append(img, viewCount);

        const copy = document.createElement('div');
        copy.className = 'atlas-card-copy';
        const meta = document.createElement('div');
        meta.className = 'atlas-card-meta';
        const tag = document.createElement('span');
        tag.className = 'tag strength';
        tag.textContent = categoryLabel(item);
        meta.append(tag);
        const title = document.createElement('h3');
        title.textContent = item.name;
        const desc = document.createElement('p');
        desc.textContent = (item.primary || []).join('・');
        copy.append(meta, title, desc);

        card.append(imageBox, copy);
        card.addEventListener('click', () => {
          if (state.selected !== item.id) {
            state.selected = item.id;
            state.view = defaultViewId(item);
            renderDetail(true);
            $('#atlas-announcement').textContent = item.name + 'を表示';
          }
          $('.atlas-study').scrollIntoView({
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
            block: 'start',
          });
        });
        return card;
      }),
    );
  }

  // ---- フィードバック（種目ごと。押した時点で選んでいる種目に紐づく）

  function resetFeedbackForm() {
    $('#atlas-feedback-input').value = '';
    $('#atlas-feedback-status').textContent = '';
    $('#atlas-feedback-status').classList.remove('is-error');
    $('#atlas-feedback-send').disabled = false;
  }

  async function sendFeedback() {
    const item = selectedExercise();
    const input = $('#atlas-feedback-input');
    const status = $('#atlas-feedback-status');
    const message = input.value.trim();
    if (!item || !message) {
      status.textContent = 'ひとことだけでも入力してください';
      status.classList.add('is-error');
      return;
    }
    const button = $('#atlas-feedback-send');
    button.disabled = true;
    status.classList.remove('is-error');
    status.textContent = '送信中…';
    try {
      const res = await fetch(SUPABASE_URL + '/rest/v1/atlas_feedback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ exercise_id: item.id, message }),
      });
      if (!res.ok) throw new Error('status ' + res.status);
      input.value = '';
      status.textContent = '送信しました。ありがとうございます。';
    } catch (err) {
      status.textContent = '送信できませんでした。少し時間をおいてお試しください。';
      status.classList.add('is-error');
    } finally {
      button.disabled = false;
    }
  }

  function wireControls() {
    const video = $('#atlas-video');

    $('#atlas-play').addEventListener('click', () => {
      if (intendedPlaying) pauseCurrent(); else playCurrent();
    });
    $('#atlas-scrub').addEventListener('input', (event) => {
      const item = selectedExercise();
      if (!item) return;
      const total = viewSeconds(item, currentView(item));
      const at = (Number(event.target.value) / 1000) * total;
      // 読み込み中は目標だけ控えて、読めてから当てる
      if (pending) pending.time = at; else video.currentTime = at;
      updateTransport();
    });
    $('#atlas-speed').addEventListener('change', (event) => {
      state.speed = Number(event.target.value);
      video.playbackRate = state.speed;
    });
    video.addEventListener('timeupdate', updateTransport);
    video.addEventListener('play', updateTransport);
    video.addEventListener('pause', updateTransport);
    video.addEventListener('error', () => {
      pending = null;
      intendedPlaying = false;
      showMessage('動画を読み込めませんでした。通信を確かめて、もう一度お試しください。', true);
      updateTransport();
    });
    $('#atlas-retry').addEventListener('click', () => loadStage(false));

    // タブを離れたら止める。全種目・全視点を先読みしないのと同じ理由で、
    // 見ていない動画を流しっぱなしにしない。**戻っただけでは再生し直さない**
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) pauseCurrent();
    });
    // **画面の外へ出たら止める**（2026-09-18）。タブは開いたままでも、
    // 下の一覧まで送った先で流しっぱなしにしない。
    // **見張るのは枠のほう**——動画そのものを見張ると、拡大した瞬間に
    // 枠からはみ出したぶんが「画面の外」と判定されて止まる（2026-09-18）
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        entries.forEach((entry) => { if (!entry.isIntersecting && intendedPlaying) pauseCurrent(); });
      }, { threshold: 0.2 }).observe($('.atlas-stage'));
    }

    $$('.atlas-filters button').forEach((button) => {
      button.addEventListener('click', () => {
        state.filter = button.dataset.filter;
        $$('.atlas-filters button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
        renderCards();
      });
    });
    $('#atlas-search-input').addEventListener('input', (event) => {
      state.query = event.target.value;
      renderCards();
    });
    $('#atlas-reset').addEventListener('click', () => {
      state.filter = 'all';
      state.query = '';
      $('#atlas-search-input').value = '';
      $$('.atlas-filters button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === 'all')));
      renderCards();
    });
    $('#atlas-feedback-send').addEventListener('click', sendFeedback);
    wireZoom();
  }

  // 5方向ある種目は 45° から見せる（ホームの絵と同じ向き）。
  // 無ければ先頭の視点
  function defaultViewId(item, angle) {
    const wanted = angle != null ? item.views.find((v) => v.angleDegrees === angle) : null;
    const fallback = item.views.find((v) => v.angleDegrees === 45);
    return (wanted || fallback || item.views[0]).id;
  }

  // ホームや他のページからの ?exercise=…&angle=… を受ける
  function pickFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('exercise');
    const item = state.exercises.find((e) => e.id === id);
    const angle = params.has('angle') ? Number(params.get('angle')) : null;
    const chosen = item
      || state.exercises.find((e) => e.id === state.defaultId)
      || state.exercises[0];
    if (!chosen) return;
    state.selected = chosen.id;
    state.view = defaultViewId(chosen, Number.isFinite(angle) ? angle : null);
  }

  async function init() {
    let data;
    try {
      // no-cache: 動画URLを追加したあとに古いデータのまま
      // 「動画は準備中」が残って見えないよう、毎回サーバーに確認させる
      const res = await fetch('img/atlas/exercise-catalog.json', { cache: 'no-cache' });
      data = await res.json();
    } catch (err) {
      $('#atlas-library').insertAdjacentHTML(
        'afterbegin',
        '<p class="note">種目データを読み込めませんでした。少し時間をおいて開き直してください。</p>',
      );
      return;
    }
    state.exercises = data.exercises;
    state.videoBase = data.videoBaseUrl || null;
    state.defaultId = data.defaultExercise || null;
    pickFromUrl();
    wireControls();
    renderDetail(true);
  }

  init();
})();
