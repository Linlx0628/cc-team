// 方案标签：管理员在方案设置里多选，成员端「请求方案」列表展示。
// 只做白名单归一，不参与路由/计费；顺序固定，保证各页面展示一致。
export const PROFILE_TAGS = Object.freeze([
  "推荐",
  "低价快用",
  "很贵很强",
  "HOT",
  "程序员专用",
  "免费",
  "不稳定",
  "很贵量少",
  "巨贵限量",
  "每人限量",
  "NEW",
]);

export const MAX_PROFILE_TAGS = 3;
const TAG_SET = new Set(PROFILE_TAGS);

export function normalizeProfileTags(value) {
  const list = Array.isArray(value) ? value : (typeof value === "string" ? value.split(",") : []);
  const picked = new Set(list.map((x) => String(x || "").trim()).filter((x) => TAG_SET.has(x)));
  return PROFILE_TAGS.filter((t) => picked.has(t)).slice(0, MAX_PROFILE_TAGS);
}
