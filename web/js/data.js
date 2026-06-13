// data.js — 把 /api/analyze 返回（或导入）的分析 JSON 解析成星海可用结构。
//
// schema: code-galaxy/v1 —— tokens(每个 occurrence 的符号名) / cluster(义项 senseId) /
//   pca / umap / occ(occurrence 元数据) / meta.clusters(义项+颜色)。
// 这里额外算两套点色：clusterColor（按 agent 判出的义项）和 symbolColor（按符号名），
// 供前端「按义项 / 按符号名」着色切换——后者同名同色、前者按义项裂成多色。

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
}

export function normalizeGalaxy(raw) {
  if (!raw || !Array.isArray(raw.tokens) || !Array.isArray(raw.pca)) throw new Error('无效分析数据');
  const n = raw.tokens.length;
  const pca = new Float32Array(n * 3), umap = new Float32Array(n * 3);
  const clusterColor = new Float32Array(n * 3), symbolColor = new Float32Array(n * 3);
  const cluster = new Float32Array(n), size = new Float32Array(n);
  const palette = (raw.meta?.clusters || []).map((c) => c.color || [0.6, 0.7, 1.0]);
  const symHue = {}; let hi = 0;

  for (let i = 0; i < n; i++) {
    pca[i*3] = raw.pca[i][0]; pca[i*3+1] = raw.pca[i][1]; pca[i*3+2] = raw.pca[i][2];
    const u = (raw.umap && raw.umap[i]) || raw.pca[i];
    umap[i*3] = u[0]; umap[i*3+1] = u[1]; umap[i*3+2] = u[2];

    const cid = raw.cluster[i] | 0; cluster[i] = cid;
    const col = palette[cid] || [0.6, 0.7, 1.0];
    clusterColor[i*3] = col[0]; clusterColor[i*3+1] = col[1]; clusterColor[i*3+2] = col[2];

    const name = raw.tokens[i];
    if (!(name in symHue)) { symHue[name] = hslToRgb((hi * 0.61803) % 1, 0.55, 0.62); hi++; }
    const sc = symHue[name];
    symbolColor[i*3] = sc[0]; symbolColor[i*3+1] = sc[1]; symbolColor[i*3+2] = sc[2];

    size[i] = 1.0 + 0.5 * (raw.size ? raw.size[i] : 0.5);
  }

  return {
    n, tokens: raw.tokens, cluster, clusterColor, symbolColor, size, pca, umap,
    occ: raw.occ || [], meta: raw.meta || {},
    // galaxy.js 构造仍读这些字段，给空值兼容（代码版不再用「测谎」失真/连线）。
    distortion: new Float32Array(n), distortionRaw: new Float32Array(n), links: [], linkScore: [],
  };
}
