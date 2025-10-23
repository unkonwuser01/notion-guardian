import "dotenv/config";
import axios from "axios";
import AdmZip from "adm-zip";
import { createWriteStream, promises as fs } from "fs";
import { join } from "path";

type NotionTask = {
  id: string;
  state: string;
  status: {
    pagesExported: number;
    exportURL: string;
  };
  error?: string;
};

const { NOTION_TOKEN, NOTION_SPACE_ID, NOTION_USER_ID } = process.env;
if (!NOTION_TOKEN || !NOTION_SPACE_ID || !NOTION_USER_ID) {
  throw new Error(
    "Environment variable NOTION_TOKEN, NOTION_SPACE_ID or NOTION_USER_ID is missing. Check the README.md for more information."
  );
}

const client = axios.create({
  baseURL: "https://www.notion.so/api/v3", // Unofficial Notion API
  headers: {
    Cookie: `token_v2=${NOTION_TOKEN};`,
    "x-notion-active-user-header": NOTION_USER_ID,
  },
});

const sleep = async (seconds: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
};

const round = (number: number) => Math.round(number * 100) / 100;

const exportFromNotion = async (
  destination: string,
  format: string
): Promise<void> => {
  const task = {
    eventName: "exportSpace",
    request: {
      spaceId: NOTION_SPACE_ID,
      shouldExportComments: false,
      exportOptions: {
        exportType: format,
        collectionViewExportType: "currentView",
        timeZone: "Europe/Berlin",
        locale: "en",
        preferredViewMap: {},
      },
    },
  };
  const {
    data: { taskId },
  }: { data: { taskId: string } } = await client.post("enqueueTask", { task });

  console.log(`Started export as task [${taskId}].`);

  let exportURL: string;
  let fileTokenCookie: string | undefined;
  
  // 轮询配置
  const POLL_INTERVAL = 3; // 每次轮询间隔 3 秒
  const MAX_POLL_ATTEMPTS = 100; // 最多轮询 100 次（5 分钟）
  let pollAttempts = 0;
  let rateLimitRetries = 0; // 用于 429 错误的指数退避

  while (pollAttempts < MAX_POLL_ATTEMPTS) {
    pollAttempts++;
    
    // 第一次也要等待，给 Notion 时间准备任务
    await sleep(POLL_INTERVAL + 2 ** rateLimitRetries);
    
    try {
      const {
        data: { results: tasks },
        headers: { "set-cookie": getTasksRequestCookies },
      }: {
        data: { results: NotionTask[] };
        headers: { [key: string]: string[] };
      } = await client.post("getTasks", { taskIds: [taskId] });
      
      const task = tasks.find((t) => t.id === taskId);

      if (!task) {
        console.log(`[Attempt ${pollAttempts}/${MAX_POLL_ATTEMPTS}] Task not found, retrying...`);
        continue;
      }

      console.log(`[Attempt ${pollAttempts}/${MAX_POLL_ATTEMPTS}] Task state: ${task.state}`);
      
      // 如果任务有页面导出信息，显示进度
      if (task.status && task.status.pagesExported) {
        console.log(`  Progress: ${task.status.pagesExported} pages exported`);
      }
      
      if (task.error) {
        throw new Error(`Export failed with reason: ${task.error}`);
      }

      if (task.state === "success") {
        // 检查 status 和 exportURL
        if (!task.status || !task.status.exportURL) {
          console.error("Task object:", JSON.stringify(task, null, 2));
          throw new Error("Task succeeded but exportURL is missing. See task object above.");
        }
        
        exportURL = task.status.exportURL;
        fileTokenCookie = getTasksRequestCookies.find((cookie) =>
          cookie.includes("file_token=")
        );
        
        if (!fileTokenCookie) {
          throw new Error("Task finished but file_token cookie not found.");
        }
        
        console.log(`✅ Export finished! Total pages: ${task.status.pagesExported || 'unknown'}`);
        break;
      }

      // 重置频率限制计数器（成功获取响应）
      rateLimitRetries = 0;
      
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        console.log(`⚠️  Rate limited (429), applying exponential backoff (${2 ** rateLimitRetries}s)...`);
        rateLimitRetries += 1;
        pollAttempts--; // 429 错误不计入轮询次数
        continue;
      }

      // 其他错误直接抛出
      throw error;
    }
  }

  // 检查是否超时
  if (pollAttempts >= MAX_POLL_ATTEMPTS) {
    throw new Error(`Export task timed out after ${MAX_POLL_ATTEMPTS} attempts (${MAX_POLL_ATTEMPTS * POLL_INTERVAL / 60} minutes).`);
  }

  const response = await client({
    method: "GET",
    url: exportURL,
    responseType: "stream",
    headers: { Cookie: fileTokenCookie },
  });

  const size = response.headers["content-length"];
  console.log(`Downloading ${round(size / 1000 / 1000)}mb...`);

  const stream = response.data.pipe(createWriteStream(destination));
  await new Promise((resolve, reject) => {
    stream.on("close", resolve);
    stream.on("error", reject);
  });
};

const extractZip = async (
  filename: string,
  destination: string
): Promise<void> => {
  const zip = new AdmZip(filename);
  zip.extractAllTo(destination, true);

  const extractedFiles = zip.getEntries().map((entry) => entry.entryName);
  const partFiles = extractedFiles.filter((name) =>
    name.match(/Part-\d+\.zip/)
  );

  // Extract found "Part-*.zip" files to destination and delete them:
  await Promise.all(
    partFiles.map(async (partFile: string) => {
      partFile = join(destination, partFile);
      const partZip = new AdmZip(partFile);
      partZip.extractAllTo(destination, true);
      await fs.unlink(partFile);
    })
  );

  const extractedFolders = await fs.readdir(destination);
  const exportFolders = extractedFolders.filter((name: string) =>
    name.startsWith("Export-")
  );

  // Move the contents of found "Export-*" folders to destination and delete them:
  await Promise.all(
    exportFolders.map(async (folderName: string) => {
      const folderPath = join(destination, folderName);
      const contents = await fs.readdir(folderPath);
      await Promise.all(
        contents.map(async (file: string) => {
          const filePath = join(folderPath, file);
          const newFilePath = join(destination, file);
          await fs.rename(filePath, newFilePath);
        })
      );
      await fs.rmdir(folderPath);
    })
  );
};

const run = async (): Promise<void> => {
  const workspaceDir = join(process.cwd(), "workspace");
  const workspaceZip = join(process.cwd(), "workspace.zip");

  await exportFromNotion(workspaceZip, "markdown");
  await fs.rm(workspaceDir, { recursive: true, force: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  await extractZip(workspaceZip, workspaceDir);
  await fs.unlink(workspaceZip);

  console.log("✅ Export downloaded and unzipped.");
};

run();