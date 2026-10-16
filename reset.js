// パスワードの再設定（2026-10-16。利用者の指示「直してください」）。
//
// 再設定のメールのリンクは `reset.html#token_hash=…&type=recovery` に着く（Supabase の Emails のテンプレートで
// `{{ .TokenHash }}` を渡す）。**`#` の後ろに置く**——`?` だとサーバー（GitHub Pages）のログに合言葉が残る。
// `#` の後ろはブラウザの外へ出ない（`?` で来ても受ける）。アプリは PKCE で再設定を頼むので、従来の `{{ .ConfirmationURL }}` だと
// 戻り先に `?code=` しか来ず、ブラウザでは交換できない（code_verifier はアプリの中）。token_hash なら
// **どの版のアプリから頼んだ再設定でも、ここで新しいパスワードを決められる**。
//
// - token_hash を確かめる（/verify）のは「パスワードを変える」を押したとき（メールの安全確認の自動巡回に先に使わせない）
// - 確かめて得たセッションはこのページの中でだけ持つ（保存しない）。変え終わったら、この端末のぶんだけ閉じる
// - URL から token_hash を消す（履歴・共有・リファラに残さない）
// - 他のサイトの枠（iframe）の中では動かない（入力を盗み見る重ね貼りに使わせない）
(() => {
  'use strict';

  // atlas.js と同じ値（公開前提の anon キー。SECURITY.md）。変えるときは両方を直す
  const SUPABASE_URL = 'https://ojyyixzjiccdmmzpdpwx.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9qeXlpeHpqaWNjZG1tenBkcHd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUwNDc0MTUsImV4cCI6MjEwMDYyMzQxNX0.7iBFdkBmT5AgBZkYnYctNu2hMrEmdB1DIbOnLRE_1bo';
  const MIN_LENGTH = 8;

  const $ = (s) => document.querySelector(s);
  const params = new URLSearchParams(location.hash.length > 1 ? location.hash.slice(1) : location.search.slice(1));
  const tokenHash = params.get('token_hash');
  const type = params.get('type') || 'recovery';
  if (tokenHash) history.replaceState(null, '', location.pathname);

  const show = (id) => {
    for (const el of document.querySelectorAll('[data-step]')) el.hidden = el.dataset.step !== id;
  };
  const say = (text) => {
    const box = $('#error');
    box.textContent = text;
    box.hidden = !text;
  };

  if (window.top !== window.self || !tokenHash || type !== 'recovery') {
    show('invalid');
    return;
  }
  show('form');

  let session = null; // { access_token }

  async function call(path, init) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
      ...init,
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body: body || {} };
  }

  const codeOf = (b) => b.error_code || b.code || '';

  function describeUpdateError(r) {
    const code = codeOf(r.body);
    const reasons = (r.body.weak_password && r.body.weak_password.reasons) || [];
    if (code === 'same_password') return '前と同じパスワードは使えません。別のパスワードにしてください。';
    if (code === 'weak_password' && reasons.includes('pwned')) {
      return 'このパスワードは、ほかのサービスから流出したパスワードの一覧に載っているため使えません。別のパスワードにしてください。';
    }
    if (code === 'weak_password' || reasons.includes('length')) return `パスワードは ${MIN_LENGTH} 文字以上にしてください。`;
    if (r.status === 401 || code === 'session_expired' || code === 'bad_jwt') {
      session = null;
      return '時間が経ちすぎました。アプリからもう一度、再設定のメールを送ってください。';
    }
    return `パスワードを変えられませんでした（${r.body.msg || r.body.message || r.status}）。`;
  }

  $('#reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    say('');
    const pw = $('#pw').value;
    const pw2 = $('#pw2').value;
    if (pw.length < MIN_LENGTH) return say(`パスワードは ${MIN_LENGTH} 文字以上にしてください。`);
    if (pw !== pw2) return say('2 つの欄のパスワードが違います。');

    const button = $('#submit');
    button.disabled = true;
    try {
      if (!session) {
        const v = await call('verify', { method: 'POST', body: JSON.stringify({ type: 'recovery', token_hash: tokenHash }) });
        if (!v.ok || !v.body.access_token) {
          show('expired');
          return;
        }
        session = { access_token: v.body.access_token };
      }
      const auth = { Authorization: `Bearer ${session.access_token}` };
      const u = await call('user', { method: 'PUT', headers: auth, body: JSON.stringify({ password: pw }) });
      if (!u.ok) {
        say(describeUpdateError(u));
        if (!session) show('expired');
        return;
      }
      // このページで開いたセッションだけ閉じる（アプリで入っている端末は閉じない）
      await call('logout?scope=local', { method: 'POST', headers: auth }).catch(() => {});
      session = null;
      $('#pw').value = '';
      $('#pw2').value = '';
      show('done');
    } catch {
      say('通信できませんでした。電波のよいところで、もう一度押してください。');
    } finally {
      button.disabled = false;
    }
  });
})();
