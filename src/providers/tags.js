// Copyright (c) 2026 Fido-labs —kcw—
// Inférence d'étiquettes (capacités) et de score de qualité à partir du nom d'un modèle.

const RE = {
  embedding: /(embed|bge-|\be5\b|gte-|nomic-embed|rerank)/i,
  vision: /(vision|llava|[-_]vl[-_\b]|[-_]vl$|pixtral|gemini|gpt-4o|gpt-4\.1|gpt-5|llama-4|llama-3\.2-(11|90)b|gemma-3|qwen.*vl|minicpm-v|molmo|paligemma|internvl)/i,
  code: /(code|coder|codestral|devstral|starcoder|deepseek-coder|granite-code)/i,
  reasoning: /(r1|reason|qwq|thinking|\bo[134](-|$)|gpt-oss|magistral|phi-4-reasoning|qwen3|deepseek-v3\.[12]|kimi-k2-thinking|nemotron.*(super|ultra))/i,
  tools: /(llama-3\.[1-3]|llama-4|qwen|mistral|mixtral|gpt|gemini|command|glm|deepseek-(v3|chat|r1)|kimi|nemotron|gemma-3|hermes|minimax)/i,
  image: /(flux|stable-diffusion|sdxl|dall-e|imagen)/i,
};

export function sizeInBillions(id) {
  const s = String(id).toLowerCase();
  const moe = s.match(/(\d+)x(\d+(?:\.\d+)?)b/);
  if (moe) return Number(moe[1]) * Number(moe[2]);
  const all = [...s.matchAll(/(\d+(?:\.\d+)?)b(?![a-z])/g)].map((x) => Number(x[1]));
  return all.length ? Math.max(...all) : null;
}

export function inferTags(id, hint = {}) {
  const s = String(id);
  const tags = new Set(hint.tags ?? []);
  if (RE.embedding.test(s)) { tags.add('embedding'); return [...tags]; }
  if (RE.image.test(s)) { tags.add('image'); return [...tags]; }
  tags.add('chat');
  if (RE.vision.test(s)) tags.add('vision');
  if (RE.code.test(s)) tags.add('code');
  if (RE.reasoning.test(s)) tags.add('reasoning');
  if (hint.tools === true || (hint.tools !== false && RE.tools.test(s))) tags.add('tools');
  const size = sizeInBillions(s);
  if (size != null) {
    if (size >= 60) tags.add('large');
    else if (size <= 14) tags.add('small');
  }
  if (/(120b|235b|405b|gemini-2\.5|gpt-4\.1|command-a|llama-4-maverick|deepseek-v3|deepseek-r1\b|kimi-k2)/i.test(s)) tags.add('large');
  return [...tags];
}

/** Score heuristique (plus haut = plus capable). Sert au mode `auto`/`smart`. */
export function quality(id) {
  const s = String(id).toLowerCase();
  let score = 0;
  const size = sizeInBillions(s);
  if (size != null) score += Math.log2(Math.max(size, 1)) * 10;
  else score += 35; // inconnu : valeur médiane
  if (/gemini-2\.5-flash(?!-lite)/.test(s)) score += 70 - (size != null ? 0 : 0);
  if (/gemini-2\.5-pro/.test(s)) score += 90;
  if (/gpt-oss-120b/.test(s)) score += 25;
  if (/deepseek-(r1|v3)/.test(s) && !/distill/.test(s)) score += 25;
  if (/qwen3-coder|qwen3-235b|kimi-k2/.test(s)) score += 20;
  if (/llama-3\.3-70b|llama-4/.test(s)) score += 10;
  if (/gpt-4\.1(?!-mini)/.test(s)) score += 20;
  if (/command-a/.test(s)) score += 10;
  if (/distill|tiny|mini|nano|lite|small|instant|\b[1-9]b\b/.test(s)) score -= 12;
  return score;
}
