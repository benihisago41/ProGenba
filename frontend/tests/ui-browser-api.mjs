import { me, projects, lookups } from './ui-fixtures.mjs';

export function installBrowserTestApi() {
  const original = window.fetch.bind(window);
  const state = { loggedIn: true, role: 'approver', failRefresh: false, postStatus: 201, expired: false, postDelay: 0, calls: [], posts: [], projects: structuredClone(projects), lookups: structuredClone(lookups) };
  window.__uiTest = state;
  window.fetch = async (url, options = {}) => {
    const path = new URL(String(url), location.href).pathname;
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (!path.startsWith('/api/v1/')) return original(url, options);
    state.calls.push(path);
    if (path.endsWith('/auth/me')) return json(state.loggedIn ? { ...me, role: state.role } : {}, state.loggedIn ? 200 : 401);
    if (path.endsWith('/auth/login')) { state.loggedIn = true; return json({ ...me, role: state.role }); }
    if (path.endsWith('/auth/logout')) { state.loggedIn = false; return json({}); }
    if (state.expired) return json({}, 401);
    if (path.endsWith('/cockpit')) return state.failRefresh ? json({ message: 'ブラウザ試験用の更新失敗' }, 503) : json(state.projects);
    if (path.endsWith('/lookups')) return state.failRefresh ? json({ message: 'ブラウザ試験用の辞書更新失敗' }, 503) : json(state.lookups);
    if (path.includes('/costs/')) {
      const body = JSON.parse(options.body); state.posts.push({ path, body });
      if (state.postDelay) await new Promise(resolve => setTimeout(resolve, state.postDelay));
      if (state.postStatus !== 201) return json({ message: 'ブラウザ試験用の登録失敗' }, state.postStatus);
      if (path.endsWith('/subcontract-progress')) {
        const order = state.lookups.subcontract_orders.find(item => item.order_number === body.order_number);
        order.accum_assessed_amount_tax_ex += body.curr_assessed_amount_tax_ex;
        order.remaining_order_balance -= body.curr_assessed_amount_tax_ex;
      }
      return json({ document_no: String(state.posts.length).padStart(12, '0'), warnings: [] }, 201);
    }
    return json({}, 404);
  };
  return 'Browser-only mock API installed. No real API/database writes.';
}
