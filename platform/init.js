(function () {
  var s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
  s.onload = run;
  document.head.appendChild(s);
})();

async function run() {
  var db = supabase.createClient(
    'https://eqpxlwbjqiwfjlsuapvu.supabase.co',
    'sb_publishable_ijLmSmMUeNBrgMGL8Aol4g_S5-xwUzD'
  );

  var params    = new URLSearchParams(window.location.search);
  var projectId = params.get('id');
  if (!projectId) return;

  var { data: project, error } = await db
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .single();

  if (error || !project) return;

  // Set title and header
  document.title = project.name;
  var headerEl = document.getElementById('header-text-value');
  if (headerEl) headerEl.textContent = project.name;

  // Share bar
  var shareBar = document.createElement('div');
  shareBar.id = 'platform-share-bar';
  shareBar.style.cssText = [
    'position:fixed', 'bottom:0', 'left:0', 'right:0',
    'background:#1e1b2e', 'color:#fff',
    'display:flex', 'align-items:center', 'gap:12px',
    'padding:8px 16px', 'font-size:13px',
    'z-index:9999', 'font-family:Helvetica Neue,Arial,sans-serif'
  ].join(';');

  var urlText = document.createElement('span');
  urlText.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9490a8;';
  urlText.textContent = window.location.href;

  var copyBtn = document.createElement('button');
  copyBtn.textContent = 'Copy link';
  copyBtn.style.cssText = [
    'background:#7c5cbf', 'color:#fff', 'border:none',
    'padding:6px 14px', 'border-radius:6px',
    'font-size:13px', 'cursor:pointer',
    'font-family:inherit', 'white-space:nowrap'
  ].join(';');
  copyBtn.addEventListener('click', function () {
    navigator.clipboard.writeText(window.location.href).then(function () {
      copyBtn.textContent = 'Copied!';
      setTimeout(function () { copyBtn.textContent = 'Copy link'; }, 2000);
    });
  });

  shareBar.appendChild(urlText);
  shareBar.appendChild(copyBtn);
  document.body.appendChild(shareBar);

  // Warn before closing without an account
  window.addEventListener('beforeunload', function (e) {
    e.preventDefault();
    e.returnValue = '';
  });
}
