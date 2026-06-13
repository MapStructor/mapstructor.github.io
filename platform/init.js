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

  // Warn before closing without an account
  window.addEventListener('beforeunload', function (e) {
    e.preventDefault();
    e.returnValue = '';
  });
}
