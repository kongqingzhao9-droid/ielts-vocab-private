(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const cfg = window.APP_CONFIG || {};
  let client, mounted = false, checking = false, activeUser = null;
  let generation = 0;
  function message(text) { $('authMessage').textContent = text; }
  function clearLegacyStorage() {
    for (const key of ['ielts_state_v1', 'ielts_deleted_v1', 'ielts_ts_v1']) localStorage.removeItem(key);
  }
  function lock(text) {
    generation++;
    if (window.disposeVocabApp) window.disposeVocabApp();
    $('appMain').hidden = true;
    $('privateNav').hidden = true;
    $('accountBar').hidden = true;
    $('authPanel').hidden = false;
    $('modal').replaceChildren();
    $('mask').classList.remove('show');
    $('ctx').style.display = 'none';
    document.body.classList.remove('paged');
    document.documentElement.classList.remove('paged');
    $('password').value = '';
    message(text || '请登录后查看私人词库。');
    activeUser = null;
  }
  async function loadPrivateLibrary() {
    if (checking) return;
    checking = true;
    const currentGeneration = generation;
    try {
      const { data: { user }, error } = await client.auth.getUser();
      if (error || !user) throw Error('登录已失效，请重新登录。');
      const owner = await client.rpc('is_vocab_owner');
      if (owner.error || owner.data !== true) throw Error('该账号没有访问此词库的权限。');
      if (currentGeneration !== generation) return;
      if (mounted && activeUser === user.id) return;
      if (mounted) { location.reload(); return; }
      message('正在读取私人词库…');
      const result = await client.from('private_vocab_library').select('payload').eq('id', true).single();
      if (result.error || !result.data?.payload) throw Error('词库读取失败，请检查网络或数据库迁移是否完成。');
      window.VocabSync.configure(client);
      const remote = await window.VocabSync.fetchAll();
      if (currentGeneration !== generation) return;
      activeUser = user.id;
      $('authPanel').hidden = true;
      $('appMain').hidden = false;
      $('privateNav').hidden = false;
      $('accountBar').hidden = false;
      await window.startVocabApp(result.data.payload, remote);
      mounted = true;
      $('password').value = '';
      if (['ielts_state_v1','ielts_deleted_v1','ielts_ts_v1'].some(k => localStorage.getItem(k))) {
        $('legacyImport').hidden = false;
      }
    } catch (error) {
      lock(error.message || '暂时无法登录，请稍后重试。');
      if (mounted) location.reload();
    } finally { checking = false; }
  }
  $('loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!client) return message('登录组件加载失败，请刷新页面重试。');
    $('loginButton').disabled = true;
    message('正在登录…');
    try {
      const { error } = await client.auth.signInWithPassword({
        email: $('email').value.trim(), password: $('password').value
      });
      $('password').value = '';
      if (error) throw Error('登录失败，请检查邮箱、密码和网络。');
      await loadPrivateLibrary();
    } catch (error) { message(error.message); }
    finally { $('loginButton').disabled = false; }
  });
  $('logoutButton').addEventListener('click', async () => {
    lock('已退出，正在清理登录信息…');
    clearLegacyStorage();
    // Local scope forgets this device's session even when other devices stay signed in.
    try { await client.auth.signOut({ scope: 'local' }); }
    finally {
      localStorage.removeItem('ielts_private_auth_v1');
      localStorage.removeItem('ielts_private_auth_v1-code-verifier');
      location.reload();
    }
  });
  $('importLegacyButton').addEventListener('click', async () => {
    $('importLegacyButton').disabled = true;
    try {
      const saved = JSON.parse(localStorage.getItem('ielts_state_v1') || '{}');
      const deleted = new Set(JSON.parse(localStorage.getItem('ielts_deleted_v1') || '[]'));
      const times = JSON.parse(localStorage.getItem('ielts_ts_v1') || '{}');
      const remote = await window.VocabSync.fetchAll();
      let uncertain = 0;
      for (const word of new Set([...Object.keys(saved), ...deleted])) {
        const value = saved[word] || {};
        const edited = value.stars || value.archived || deleted.has(word) || times[word];
        if (!edited) continue;
        if (!times[word] && remote[word]) {
          const row = remote[word];
          if ((value.stars || 0) !== row.stars || !!value.archived !== row.archived || deleted.has(word) !== row.deleted) uncertain++;
          continue;
        }
        if (times[word] && Number(times[word]) <= Date.parse(remote[word]?.updated_at || '1970-01-01')) continue;
        await window.VocabSync.push(word, Math.min(5, Math.max(0, Number(value.stars) || 0)), !!value.archived, deleted.has(word));
      }
      if (uncertain) {
        $('importMessage').textContent = `可确认的较新记录已导入。另有 ${uncertain} 条旧记录缺少时间，无法确定先后，缓存已保留。可刷新查看，或明确选择使用云端记录。`;
        $('importLegacyButton').disabled = false;
        return;
      }
      clearLegacyStorage();
      location.reload();
    } catch (_) {
      $('importMessage').textContent = '导入未完成，旧记录仍保留。请检查网络后重试。';
      $('importLegacyButton').disabled = false;
    }
  });
  $('discardLegacyButton').addEventListener('click', () => {
    clearLegacyStorage(); $('legacyImport').hidden = true;
  });
  async function boot() {
    try {
      if ('serviceWorker' in navigator && location.protocol !== 'file:') {
        await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
      }
      if ('caches' in window) {
        for (const key of await caches.keys()) if (key.startsWith('ielts-vocab-')) await caches.delete(key);
      }
      if (!window.supabase || !cfg.supabaseUrl || !cfg.supabaseAnonKey) throw Error('登录组件未配置或未加载。');
      client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'ielts_private_auth_v1' },
        global: { fetch: (input, init = {}) => fetch(input, { ...init, cache: 'no-store' }) }
      });
      client.auth.onAuthStateChange(event => {
        if (event === 'SIGNED_OUT') {
          lock('登录已退出，请重新登录。');
          if (mounted) location.reload();
        }
        if (event === 'SIGNED_IN') setTimeout(loadPrivateLibrary, 0);
      });
      const { data: { session } } = await client.auth.getSession();
      if (session) await loadPrivateLibrary();
      else message('请登录后查看私人词库。');
      window.addEventListener('pageshow', event => { if (event.persisted) { lock('正在重新验证登录…'); location.reload(); } });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && mounted) loadPrivateLibrary();
      });
      window.addEventListener('vocab-auth-error', loadPrivateLibrary);
    } catch (error) { lock(error.message || '初始化失败，请刷新重试。'); }
  }
  boot();
})();
