/**
 * docker.js — dockerode 封装（模块 C）
 *
 * 通过 /var/run/docker.sock 操作宿主 Docker：
 * - pull（含全部 tag）、rmi、prune（仅 dangling）
 * - 定时重启本容器兜底（docker.restart(HOSTNAME)）
 * - 客户端可注入（测试用 mock）
 */

import Docker from 'dockerode';
import config from '../config.js';

export function createDockerClient({ socketPath = config.dockerSocket, DockerImpl = Docker } = {}) {
  const docker = new DockerImpl({ socketPath });

  /** pull：'ns/repo' 或 'ns/repo:tag'；等待完成 */
  async function pull(imageRef) {
    const stream = await docker.pull(imageRef);
    await new Promise((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
      stream.resume();
    });
    // 确认镜像实际可用（pull 流结束不代表 manifest 完整）
    await docker.getImage(imageRef).inspect();
  }

  /** rmi：删除本地镜像 */
  async function remove(imageRef) {
    await docker.getImage(imageRef).remove({ force: false });
  }

  /** prune：仅清理 dangling 镜像 */
  async function pruneDangling() {
    return docker.pruneImages({ filters: { dangling: ['true'] } });
  }

  /** 重启容器（自身兜底）；containerId 默认取 HOSTNAME 环境变量 */
  async function restartContainer(containerId = config.hostname) {
    if (!containerId) throw new Error('未配置 HOSTNAME，无法定位本容器');
    await docker.getContainer(containerId).restart();
  }

  /** df 汇总（信息展示用，非空间预检依据） */
  async function df() {
    return docker.df();
  }

  return { docker, pull, remove, pruneDangling, restartContainer, df };
}

export default createDockerClient();
