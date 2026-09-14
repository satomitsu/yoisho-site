// 筋トレ図鑑（atlas.html）。
//
// 種目データは img/atlas/exercise-catalog.json（実体は
// assets/site/atlas/exercise-catalog.json）から読む。60種目に増えても
// このファイルは変えず、データを足すだけで済む形にしてある。
//
// 動画は各視点（views[].video）が URL を持てば自動で有効になり、無ければ
// 静止画（poster）のまま「動画は準備中」と出す。全視点を先読みせず、
// 選んだ視点の分だけ src を張る。タブを離れたら止める。同じ種目のまま
// 視点を替えたときだけ、動作位置・再生中かどうか・速度を次の動画へ引き継ぐ
// （RELEASE.md「筋トレ図鑑」節）。
(() => {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  // anon キー。公開前提（RLS が唯一の防壁。SECURITY.md）——iOS/Androidアプリの
  // バンドルにも同じ値がそのまま入っている。書き込み先は atlas_feedback だけで、
  // 読み・更新・削除の権限は与えていない（migration 111）
  const SUPABASE_URL = 'https://ojyyixzjiccdmmzpdpwx.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9qeXlpeHpqaWNjZG1tenBkcHd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUwNDc0MTUsImV4cCI6MjEwMDYyMzQxNX0.7iBFdkBmT5AgBZkYnYctNu2hMrEmdB1DIbOnLRE_1bo';

  const REGION_LABELS = { chest: '胸', back: '背中', legs: '脚・尻' };

  const state = { exercises: [], selected: null, view: null, filter: 'all', query: '', speed: 1 };
  // 種目を替えたときは動作位置を持ち越さない（視点を替えたときだけ持ち越す）
  let stageExerciseId = null;

  function normalize(value) {
    return value.normalize('NFKC').toLowerCase().replace(/[\s・ー]/g, '');
  }

  function categoryLabel(exercise) {
    return exercise.regions.map((r) => REGION_LABELS[r] || r).join('・');
  }

  function selectedExercise() {
    return state.exercises.find((e) => e.id === state.selected) || state.exercises[0];
  }

  // 動画（あれば）と静止画（無ければ）を切り替える。
  // **視点を替えたときだけ**、動作位置・再生中かどうか・速度を次の動画へ引き継ぐ
  // （種目を替えたときは引き継がない——その種目の最初から見せる）
  function updateStage() {
    const item = selectedExercise();
    if (!item) return;
    const view = item.views.find((v) => v.id === state.view) || item.views[0];
    state.view = view.id;

    const img = $('#atlas-image');
    const video = $('#atlas-video');
    const placeholder = $('#atlas-video-placeholder');
    const speedGroup = $('#atlas-video-speed');

    const sameExercise = stageExerciseId === item.id;
    stageExerciseId = item.id;
    const carryTime = sameExercise && !video.hidden ? video.currentTime : 0;
    const carryPlaying = sameExercise && !video.hidden && !video.paused;

    $('#atlas-stage-badge').textContent = view.video ? '動画' : '静止画プレビュー';
    $('.atlas-stage').classList.toggle('has-video', Boolean(view.video));

    if (view.video) {
      img.hidden = true;
      video.hidden = false;
      video.controls = true;
      video.poster = view.poster;
      video.playbackRate = state.speed;
      video.src = view.video;
      video.load();
      video.addEventListener('loadedmetadata', function onLoaded() {
        video.removeEventListener('loadedmetadata', onLoaded);
        video.currentTime = Math.min(carryTime, video.duration || 0);
        if (carryPlaying) video.play().catch(() => {});
      });
      placeholder.hidden = true;
      speedGroup.hidden = false;
    } else {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.hidden = true;
      img.hidden = false;
      img.src = view.poster;
      img.alt = item.name + 'の筋肉と姿勢・' + view.label;
      placeholder.hidden = false;
      speedGroup.hidden = true;
    }

    $('#atlas-view-label').textContent = view.label + 'から';
    $$('#atlas-view-options button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.view === view.id));
    });
  }

  function renderDetail() {
    const item = selectedExercise();
    if (!item) return;
    $('#atlas-category').textContent = categoryLabel(item);
    $('#atlas-equipment').textContent = item.equipment ? '・' + item.equipment : '';
    $('#atlas-exercise-title').textContent = item.name;
    $('#atlas-exercise-variant').textContent = item.variant || '';
    $('#atlas-duration').textContent = item.referenceCycleSeconds
      ? '1往復 ' + item.referenceCycleSeconds + '秒'
      : '';
    resetFeedbackForm();

    for (const role of ['primary', 'assist']) {
      const ul = $('#atlas-' + role);
      ul.replaceChildren(
        ...(item[role] || []).map((text) => {
          const li = document.createElement('li');
          li.className = 'chip';
          li.textContent = text;
          return li;
        }),
      );
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
          state.view = view.id;
          updateStage();
          $('#atlas-announcement').textContent = item.name + 'を' + view.label + 'から表示';
        });
        return b;
      }),
    );

    updateStage();
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
        img.width = 1000;
        img.height = 750;
        img.src = view.poster;
        const viewCount = document.createElement('span');
        viewCount.className = 'chip atlas-card-view';
        viewCount.textContent = item.views.length + '視点';
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
          state.selected = item.id;
          state.view = null;
          renderDetail();
          $('#atlas-announcement').textContent = item.name + 'を表示';
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
    $('#atlas-feedback-send').addEventListener('click', sendFeedback);
    $$('#atlas-video-speed button').forEach((button) => {
      button.addEventListener('click', () => {
        state.speed = parseFloat(button.dataset.speed);
        $('#atlas-video').playbackRate = state.speed;
        $$('#atlas-video-speed button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
      });
    });
    // タブを離れたら止める。全種目・全視点を先読みしないのと同じ理由で、
    // 見ていない動画を流しっぱなしにしない
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) $('#atlas-video').pause();
    });
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
    state.selected = state.exercises[0] && state.exercises[0].id;
    wireControls();
    renderDetail();
  }

  init();
})();
