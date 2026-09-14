/**
 * Asks GitHub to run the Garmin sync, on a schedule GitHub itself will honour.
 *
 * GitHub Actions drops almost every cron slot it is given in the 05:00-11:00
 * UTC window on a free public repository - three mornings running it granted
 * none at all, while handing out afternoon and evening slots freely. That is
 * the one window that matters here, since it is when the wearer wakes up.
 * A dispatch through the API is not throttled that way, so this Worker fires
 * the dispatch and GitHub does the work.
 *
 * Nothing secret lives in this file. The token is a Worker secret, set in the
 * dashboard and never committed.
 */

const REPO = 'tgolembiewski/sleep-tracker';
const WORKFLOW = 'garmin-sync.yml';

async function dispatch(token) {
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        // GitHub rejects API calls that do not identify themselves.
        'User-Agent': 'sleep-tracker-cron',
      },
      /* Several fires a morning, because no fixed hour can know when the watch
         will sync - once it has, skip means the rest cost nothing. */
      body: JSON.stringify({ ref: 'main', inputs: { days: '1', skip: 'true' } }),
    },
  );

  if (response.status === 204) return { ok: true, status: 204 };
  return { ok: false, status: response.status, detail: await response.text() };
}

export default {
  async scheduled(event, env) {
    const result = await dispatch(env.GITHUB_TOKEN);
    // Shows up in `wrangler tail` and the dashboard's live logs.
    console.log(result.ok
      ? 'dispatched'
      : `dispatch failed: ${result.status} ${result.detail.slice(0, 200)}`);
  },

  /* A way to prove the setup works without waiting for the next cron fire.
     Behind a key of its own so the Worker's URL is not a button anyone who
     finds it can press; without a correct key it admits to nothing. */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/run' || url.searchParams.get('key') !== env.TRIGGER_KEY) {
      return new Response('Not found', { status: 404 });
    }
    const result = await dispatch(env.GITHUB_TOKEN);
    return new Response(
      result.ok ? 'Sync dispatched.\n' : `Failed: ${result.status}\n${result.detail}\n`,
      { status: result.ok ? 200 : 502, headers: { 'Content-Type': 'text/plain' } },
    );
  },
};
