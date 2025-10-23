import { Client } from '@notionhq/client';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';

// --- 配置常量 ---
const WORKSPACE_DIR = path.join(__dirname, 'workspace'); // 备份文件将解压到这个目录
const DOWNLOAD_PATH = path.join(__dirname, 'notion-backup.zip'); // 临时下载路径
const RETRY_DELAY = 5000; // 轮询间隔 (5秒)
const MAX_RETRIES = 60; // 最大轮询次数 (5秒 * 60 = 5分钟超时)

/**
 * 延迟函数
 * @param ms 延迟的毫秒数
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 主执行函数
 */
async function run() {
  console.log('--- Notion Backup Script Started ---');

  // 从环境变量中获取机密信息
  const notionToken = process.env.NOTION_TOKEN;
  const spaceId = process.env.NOTION_SPACE_ID;

  if (!notionToken || !spaceId) {
    throw new Error('Missing environment variables: NOTION_TOKEN or NOTION_SPACE_ID');
  }

  try {
    // 1. 启动导出任务并获取导出 URL
    const exportUrl = await getNotionExportUrl(notionToken, spaceId);

    // 2. 下载备份文件
    await downloadFile(exportUrl, DOWNLOAD_PATH);

    // 3. 解压备份文件
    unzipBackup(DOWNLOAD_PATH, WORKSPACE_DIR);

    // 4. 清理临时下载的 zip 文件
    fs.unlinkSync(DOWNLOAD_PATH);

    console.log('✅ Notion workspace backup completed successfully!');
  } catch (error) {
    console.error('❌ Backup process failed:', error);
    process.exit(1); // 以错误码退出，使 GitHub Actions 任务失败
  }
}

/**
 * 启动 Notion 导出任务并轮询以获取下载 URL
 * @param token Notion API Token
 * @param spaceId Notion Space ID
 */
async function getNotionExportUrl(token: string, spaceId: string): Promise<string> {
  const notion = new Client({ auth: token });

  console.log('Step 1: Enqueueing Notion workspace export task...');
  const
  const taskResponse = await notion.enqueueTask({
    task: {
      eventName: 'exportWorkspace',
      request: {
        spaceId: spaceId,
        exportOptions: {
          exportType: 'markdown',
          timeZone: 'Asia/Shanghai',
          locale: 'en',
        },
      },
    },
  });

  const taskId = taskResponse.taskId;
  console.log(`Task enqueued with ID: ${taskId}`);

  // 轮询任务状态
  for (let i = 0; i < MAX_RETRIES; i++) {
    await delay(RETRY_DELAY);
    console.log(`Polling task status... Attempt ${i + 1}/${MAX_RETRIES}`);

    const statusResponse = await notion.getTasks({ taskId });
    const task = statusResponse.results?.[0]; // 假设 getTasks 返回一个包含 results 的对象

    if (!task) {
      console.warn(`Could not retrieve status for task ID: ${taskId}. Retrying...`);
      continue;
    }

    switch (task.state) {
      case 'success':
        console.log('Export task succeeded! Export URL received.');
        // 注意：这里的路径可能需要根据 Notion API 的实际返回结构进行微调
        if (task.status?.exportURL) {
            return task.status.exportURL;
        } else {
            throw new Error('Task successful, but exportURL is missing from the response.');
        }

      case 'failure':
        throw new Error(`Notion export task failed: ${task.status?.error || 'Unknown error'}`);
      
      case 'in_progress':
      default:
        console.log(`Task state: ${task.state}. Waiting...`);
        break;
    }
  }

  throw new Error('Notion export task timed out after multiple retries.');
}

/**
 * 从给定的 URL 下载文件
 * @param url 文件 URL
 * @param outputPath 本地保存路径
 */
async function downloadFile(url: string, outputPath: string) {
  console.log(`Step 2: Downloading backup file from URL...`);
  const writer = fs.createWriteStream(outputPath);
  
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

/**
 * 解压备份文件并清理
 * @param zipPath zip 文件路径
 * @param outputDir 解压目标目录
 */
function unzipBackup(zipPath: string, outputDir: string) {
  console.log(`Step 3: Unzipping backup file to ${outputDir}...`);

  // 如果 workspace 目录已存在，先清空它，避免旧文件残留
  if (fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outputDir, { recursive: true });

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(outputDir, true); // true 表示覆盖现有文件
}

// 运行脚本
run();
