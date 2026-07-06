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

  // Set the browser tab title (projectLoader owns the on-page header name — for the viewer that's the
  // PUBLISHED name, so don't set the header here or we'd leak the live name onto a published view).
  document.title = project.name;
}
