// prompt-diff.js - word-level diff of two prompts, for the "what changed" view.
// Classic LCS on words (prompts are short, so O(n*m) is fine).
// Returns [{ op: 'same'|'add'|'del', text }] with neighbouring runs merged.
export function diffWords(a, b) {
  const A = String(a || '').split(/(\s+)/).filter((x) => x !== '');
  const B = String(b || '').split(/(\s+)/).filter((x) => x !== '');
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  const push = (op, text) => { const last = out.at(-1); if (last && last.op === op) last.text += text; else out.push({ op, text }); };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { push('same', A[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) push('del', A[i++]);
    else push('add', B[j++]);
  }
  while (i < n) push('del', A[i++]);
  while (j < m) push('add', B[j++]);
  return out;
}
