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

export async function loadGalaxy() {
  let raw = null;
  for (const url of DATA_URLS) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) { raw = await res.json(); break; }
    } catch (_) { /* 试下一个 */ }
  }
  if (!raw) throw new Error('找不到星系数据，请先运行 pipeline 生成 data/galaxy.json');
  return normalize(raw);
}

// 把 JSON 里的嵌套数组拍平成 Float32Array，喂给 GPU 更高效
function normalize(raw) {
  const n = raw.tokens.length;
  const pca = new Float32Array(n * 3);
  const umap = new Float32Array(n * 3);
  const clusterColor = new Float32Array(n * 3);
  const distortion = new Float32Array(n);
  const cluster = new Float32Array(n);
  const size = new Float32Array(n);

  const palette = (raw.meta?.clusters || []).map(c => c.color || [0.6, 0.7, 1.0]);

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

    distortion[i] = raw.distortion[i];
    // 高频词（靠前）画得更大更亮，让星系有层次
    size[i] = 0.8 + 1.8 * (raw.size ? raw.size[i] : Math.random());
  }

  return {
    n,
    tokens: raw.tokens,
    cluster, clusterColor, distortion, size,
    pca, umap,
    links: raw.links || [],   // 真·近邻连线（[i,j] 索引对）
    meta: raw.meta || {},
  };
}
