/**
 * dockerhub.js — Docker Hub API 客户端（模块 B 扫描 / 模块 C 列 tag）
 *
 * - 扫描：GET /v2/repositories/{namespace}/?page=N&page_size=100（page_size 上限 100）
 * - 列 tag：GET /v2/repositories/{ns}/{repo}/tags/?page=N&page_size=100
 * - 头像：GET /v2/users/{name}/ → gravatar_url（/avatar/ 端点实测 404，不可用）
 * - storage_size 为 null 时回退该仓库 tags 端点最新 tag 的 full_size
 * - fetch 可注入（测试）
 */

import config from '../config.js';

const HUB_PAGE_SIZE = 100;

export function createDockerHubClient({ fetchImpl = fetch, baseUrl = config.dockerHubBase } = {}) {
  async function hubGet(path) {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`Docker Hub API ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  /** 单仓库 tags（按 last_updated 倒序，取前 limit 个；limit=0 全部） */
  async function listTags(repo, { limit = config.maxTagsPerRepo } = {}) {
    const tags = [];
    let page = 1;
    for (;;) {
      const data = await hubGet(
        `/v2/repositories/${repo}/tags/?page=${page}&page_size=${HUB_PAGE_SIZE}`
      );
      const results = data.results || [];
      tags.push(...results);
      const nextUrl = data.next;
      if (!nextUrl || results.length === 0) break;
      if (limit > 0 && tags.length >= limit) break;
      page++;
    }
    tags.sort((a, b) => new Date(b.last_updated || 0) - new Date(a.last_updated || 0));
    return limit > 0 ? tags.slice(0, limit) : tags;
  }

  /** 取仓库最新 tag 的 full_size（storage_size 回退用）；失败返回 null */
  async function fallbackSize(repo) {
    try {
      const tags = await listTags(repo, { limit: 1 });
      const t = tags[0];
      return t && typeof t.full_size === 'number' ? t.full_size : null;
    } catch {
      return null;
    }
  }

  /**
   * 扫描用户名下全部公开仓库
   * @returns {{repos:Array, total_size:number, truncated:boolean, failed:Array}}
   */
  async function scanUserRepos(namespace, { limit = config.maxReposScan } = {}) {
    const repos = [];
    const failed = [];
    let page = 1;
    let truncated = false;
    for (;;) {
      let data;
      try {
        data = await hubGet(`/v2/repositories/${namespace}/?page=${page}&page_size=${HUB_PAGE_SIZE}`);
      } catch (err) {
        throw err; // 用户名无效/网络错误：整体失败，由上层处理
      }
      const results = data.results || [];
      for (const r of results) {
        let size = typeof r.storage_size === 'number' ? r.storage_size : null;
        if (size === null) {
          size = await fallbackSize(`${namespace}/${r.name}`);
          if (size === null && typeof r.storage_size === 'number') size = r.storage_size;
        }
        if (size === null) {
          // 回退失败：记 0 并单独标注
          failed.push({ repo: `${namespace}/${r.name}`, reason: '容量获取失败（已按 0 计入）' });
          size = 0;
        }
        repos.push({
          repo: `${namespace}/${r.name}`,
          latest_tag: null, // 下方补充
          description: r.description ?? '',
          storage_size: size,
          last_updated: r.last_updated ?? null,
        });
      }
      // 补充 latest_tag：取最新 tag 名称
      for (const item of repos.slice(repos.length - results.length)) {
        try {
          const tags = await listTags(item.repo, { limit: 1 });
          item.latest_tag = tags[0]?.name ?? null;
        } catch {
          item.latest_tag = null;
        }
      }
      if (limit > 0 && repos.length >= limit) {
        truncated = Boolean(data.next) || (typeof data.count === 'number' && data.count > limit);
        if (repos.length > limit) {
          // 超限截断
          const removed = repos.splice(limit);
          failed.push(
            ...removed.map((r) => ({
              repo: r.repo,
              reason: `超过数量上限 ${limit}，已截断`,
            }))
          );
        }
        break;
      }
      const nextUrl = data.next;
      if (!nextUrl || results.length === 0) break;
      page++;
    }
    const total_size = repos.reduce((s, r) => s + (r.storage_size || 0), 0);
    return { repos, total_size, truncated, failed };
  }

  /** 用户头像：/v2/users/{name}/ 的 gravatar_url（失败返回 null） */
  async function getUserAvatar(namespace) {
    try {
      const data = await hubGet(`/v2/users/${namespace}/`);
      return data.gravatar_url ?? null;
    } catch {
      return null;
    }
  }

  return { listTags, scanUserRepos, getUserAvatar };
}

export default createDockerHubClient();
