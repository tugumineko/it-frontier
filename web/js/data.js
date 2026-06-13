// data.js — 加载并解析星系数据
//
// 数据来自构建期 Python 管线（pipeline/）：
//   - 真实数据：GPT-2 词向量 → PCA/UMAP 降维到 3D → 每点失真分
//   - 演示用：pipeline/generate_mock_data.py 生成的合成星系（无需 ML 依赖）
// 两者格式完全一致，见 README 的「数据格式」一节。

const DATA_URLS = [
  './data/galaxy.json',          // 优先：真实/最新生成的数据
  './data/galaxy.sample.json',   // 兜底：仓库自带的小样本
];

// 取原始数据集(galaxy.json schema)。保留原始结构用于"保存数据"(归一化后是 Float32Array，无法直接 JSON)。
export async function loadGalaxyRaw() {
  let raw = null;
  for (const url of DATA_URLS) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) { raw = await res.json(); break; }
    } catch (_) { /* 试下一个 */ }
  }
  if (!raw) throw new Error('找不到星系数据，请先运行 pipeline 生成 data/galaxy.json');
  return raw;
}

export async function loadGalaxy() { return normalizeGalaxy(await loadGalaxyRaw()); }

// 把 JSON 里的嵌套数组拍平成 Float32Array，喂给 GPU 更高效
export function normalizeGalaxy(raw) {
  if (!raw || !Array.isArray(raw.tokens) || !Array.isArray(raw.pca)) throw new Error('无效星系数据');
  const n = raw.tokens.length;
  const pca = new Float32Array(n * 3);
  const umap = new Float32Array(n * 3);
  const clusterColor = new Float32Array(n * 3);
  const distortion = new Float32Array(n);
  const cluster = new Float32Array(n);
  const size = new Float32Array(n);

  const palette = (raw.meta?.clusters || []).map(c => c.color || [0.6, 0.7, 1.0]);

  // distortion 是旧「测谎」方向的字段；词义星海方向不再需要，缺失时按 0 处理（兼容旧数据）。
  const hasDist = Array.isArray(raw.distortion) && raw.distortion.length === n;
  const rawD = hasDist ? raw.distortion.slice().sort((a, b) => a - b) : [0];
  const q = (p) => rawD[Math.min(rawD.length - 1, Math.max(0, Math.floor(p * (rawD.length - 1))))];
  const lo = hasDist ? q(0.02) : 0, hi = hasDist ? q(0.98) : 1, span = (hi - lo) || 1;
  const distortionRaw = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    pca[i * 3] = raw.pca[i][0];
    pca[i * 3 + 1] = raw.pca[i][1];
    pca[i * 3 + 2] = raw.pca[i][2];
    umap[i * 3] = raw.umap[i][0];
    umap[i * 3 + 1] = raw.umap[i][1];
    umap[i * 3 + 2] = raw.umap[i][2];

    const cid = raw.cluster[i] | 0;
    cluster[i] = cid;
    const col = palette[cid] || [0.6, 0.7, 1.0];
    clusterColor[i * 3] = col[0];
    clusterColor[i * 3 + 1] = col[1];
    clusterColor[i * 3 + 2] = col[2];

    distortionRaw[i] = hasDist ? raw.distortion[i] : 0;
    distortion[i] = hasDist ? Math.max(0, Math.min(1, (raw.distortion[i] - lo) / span)) : 0;
    // 大小仅做轻微纹理变化(词频)，范围压窄，避免"大/亮"被误读为"可信"——失真只看颜色
    size[i] = 1.0 + 0.5 * (raw.size ? raw.size[i] : Math.random());
  }

  return {
    n,
    tokens: raw.tokens,
    cluster, clusterColor, distortion, distortionRaw, size,
    pca, umap,
    links: raw.links || [],          // 全局错配连线（[i,j] 索引对）
    linkScore: raw.link_score || [], // 每条连线的全局错配度 0..1
    meta: raw.meta || {},
  };
}
