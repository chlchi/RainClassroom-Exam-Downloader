import { promises as fs } from "fs";
import { join, resolve } from "path";
import { loadConfig, updateConfig } from "./config";
import { getMockResponse } from "./har-parser";
import { PDFDocument } from "pdf-lib";
import pptxgen from "pptxgenjs";

// 1x1 transparent/black pixel JPEG base64 fallback for offline mode
const MOCK_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64"
);

export function cleanFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim();
}

// WebSocket progress clients Set
export const progressClients = new Set<any>();

export function broadcastProgress(
  lessonId: string,
  percent: number,
  speed: string,
  status: "pending" | "downloading" | "completed" | "failed"
) {
  const payload = JSON.stringify({
    type: "download_progress",
    lessonId,
    percent,
    speed,
    status
  });
  for (const client of progressClients) {
    try {
      client.send(payload);
    } catch {
      progressClients.delete(client);
    }
  }
}

function parseYuketangJson(text: string): any {
  return JSON.parse(text, (_key, value, context?: { source?: string }) => {
    // Lesson IDs can exceed JavaScript's safe integer range; retain their exact digits.
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value) && context?.source) {
      return context.source;
    }
    return value;
  });
}

async function fetchFromYuketang(urlStr: string): Promise<any> {
  const config = await loadConfig();
  if (config.offlineMode) {
    const mock = getMockResponse("GET", urlStr);
    if (!mock) {
      throw new Error(`Offline cache miss for YuKeTang URL: ${urlStr}`);
    }
    return parseYuketangJson(mock.text);
  }

  const cookies = config.cookies;
  const cookieHeader = [
    `sessionid=${cookies.sessionid}`,
    `csrftoken=${cookies.csrftoken}`,
    `xtbz=${cookies.xtbz}`,
    `university_id=${cookies.university_id}`,
    `platform_id=${cookies.platform_id}`
  ];
  if (cookies._cf_bm) {
    cookieHeader.push(`_cf_bm=${cookies._cf_bm}`);
  }

  const res = await fetch(urlStr, {
    method: "GET",
    headers: {
      "cookie": cookieHeader.join("; "),
      "x-csrftoken": cookies.csrftoken,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "referer": "https://www.yuketang.cn/",
      "xtbz": cookies.xtbz || "ykt",
      "university-id": cookies.university_id || "",
      "platform-id": cookies.platform_id || "3",
      "x-client": "web",
      "terminal-type": "web"
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch from YuKeTang, status: ${res.status}`);
  }
  return parseYuketangJson(await res.text());
}

async function refreshXuetangxAuth(classroomId: string, examId: string): Promise<string> {
  const config = await loadConfig();
  if (config.offlineMode) {
    return "";
  }

  const cookies = config.cookies;
  const cookieStr = [
    `sessionid=${cookies.sessionid}`,
    `csrftoken=${cookies.csrftoken}`,
    `xtbz=${cookies.xtbz}`,
    `university_id=${cookies.university_id}`,
    `platform_id=${cookies.platform_id}`
  ];
  if (cookies._cf_bm) {
    cookieStr.push(`_cf_bm=${cookies._cf_bm}`);
  }

  // 1. POST to gen_token
  const genTokenUrl = "https://www.yuketang.cn/v/exam/gen_token";
  const genTokenRes = await fetch(genTokenUrl, {
    method: "POST",
    headers: {
      "cookie": cookieStr.join("; "),
      "x-csrftoken": cookies.csrftoken || "",
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "referer": `https://www.yuketang.cn/v2/web/exam/${classroomId}/${examId}`
    },
    body: JSON.stringify({
      exam_id: Number(examId),
      classroom_id: Number(classroomId)
    })
  });

  if (!genTokenRes.ok) {
    throw new Error(`Failed to generate token from Rain Classroom, status: ${genTokenRes.status}`);
  }

  const genTokenJson = await genTokenRes.json();
  if (!genTokenJson.success) {
    throw new Error(`gen_token API returned failure: ${genTokenJson.msg || "unknown error"}`);
  }

  const { token, user_id, exam_host } = genTokenJson.data;

  // 2. GET to login
  const nextUrl = `${exam_host}/result/${examId}?isFrom=2`;
  const loginUrl = `${exam_host}/login?exam_id=${examId}&user_id=${user_id}&crypt=${encodeURIComponent(token)}&next=${encodeURIComponent(nextUrl)}&language=zh`;

  const loginRes = await fetch(loginUrl, {
    method: "GET",
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    },
    redirect: "manual"
  });

  // Extract set-cookie headers
  const setCookieHeaders = loginRes.headers.getSetCookie();
  let xAccessToken = "";
  for (const cookieStr of setCookieHeaders) {
    const [part] = cookieStr.split(";");
    const [key, val] = part.split("=");
    if (key && val && key.trim() === "x_access_token") {
      xAccessToken = val.trim();
    }
  }

  if (!xAccessToken) {
    throw new Error(`Did not receive x_access_token from Xuetangx login redirect`);
  }

  // 3. Update configuration
  await updateConfig({
    cookies: {
      x_access_token: xAccessToken
    }
  });

  return xAccessToken;
}

async function fetchFromXuetangx(urlStr: string): Promise<any> {
  const config = await loadConfig();
  if (config.offlineMode) {
    const mock = getMockResponse("GET", urlStr);
    if (!mock) {
      throw new Error(`Offline cache miss for Xuetangx URL: ${urlStr}`);
    }
    return JSON.parse(mock.text);
  }

  const cookies = config.cookies;
  const cookieParts: string[] = [];
  if (cookies.x_access_token) cookieParts.push(`x_access_token=${cookies.x_access_token}`);
  if (cookies._abfpc) cookieParts.push(`_abfpc=${cookies._abfpc}`);
  if (cookies.cna) cookieParts.push(`cna=${cookies.cna}`);
  if (cookies.sensorsdata2015jssdkcross) cookieParts.push(`sensorsdata2015jssdkcross=${cookies.sensorsdata2015jssdkcross}`);
  if (cookies.xt_lang) cookieParts.push(`xt_lang=${cookies.xt_lang}`);

  // Fallback to yuketang cookies if no xuetangx cookies are set
  if (cookieParts.length === 0) {
    cookieParts.push(
      `sessionid=${cookies.sessionid}`,
      `csrftoken=${cookies.csrftoken}`,
      `xtbz=${cookies.xtbz}`,
      `university_id=${cookies.university_id}`,
      `platform_id=${cookies.platform_id}`
    );
    if (cookies._cf_bm) {
      cookieParts.push(`_cf_bm=${cookies._cf_bm}`);
    }
  }
  const cookieHeader = cookieParts.join("; ");

  const res = await fetch(urlStr, {
    method: "GET",
    headers: {
      "cookie": cookieHeader,
      "x-csrftoken": cookies.csrftoken || "",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "referer": "https://examination.xuetangx.com/",
      "x-client": "web",
      "xtbz": "cloud"
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch from Xuetangx, status: ${res.status}`);
  }
  return await res.json();
}

function cleanHtml(html: string): string {
  if (!html) return "";
  let text = html;

  // Replace images
  text = text.replace(/<img[^>]+src="([^">]+)"[^>]*>/gi, "![]($1)");
  text = text.replace(/<img[^>]+src='([^'>]+)'[^>]*>/gi, "![]($1)");

  // Replace line breaks / paragraphs
  text = text.replace(/<\/p>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Remove other HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

  return text.trim();
}

async function findActivityInLogs(
  classroomId: string,
  leafTitle: string,
  targetTypes: number[]
): Promise<any | null> {
  let page = 0;
  const offset = 100;
  let lastFirstId: any = null;
  const maxPages = 10;

  while (page < maxPages) {
    try {
      const logsUrl = `https://www.yuketang.cn/v2/api/web/logs/learn/${classroomId}?actype=-1&page=${page}&offset=${offset}&sort=-1`;
      const logsData = await fetchFromYuketang(logsUrl);
      const activities = logsData.data?.activities || [];
      if (activities.length === 0) {
        break;
      }

      // Prevent infinite loops in offline mock mode
      const currentFirstId = activities[0]?.id;
      if (currentFirstId !== undefined && currentFirstId === lastFirstId) {
        console.log(`[Downloader] Duplicate activity list detected at page ${page}, stopping log search.`);
        break;
      }
      lastFirstId = currentFirstId;

      const match = activities.find((act: any) => {
        if (!targetTypes.includes(act.type)) return false;
        const actTitle = (act.title || "").trim().toLowerCase();
        const targetTitle = leafTitle.trim().toLowerCase();
        return actTitle === targetTitle;
      });

      if (match) {
        return match;
      }
      if (activities.length < offset) {
        break;
      }
      page++;
    } catch (err) {
      console.warn(`[Downloader] Error fetching logs page ${page}:`, err);
      break;
    }
  }
  return null;
}

async function resolveLessonId(
  classroomId: string,
  leafId: string,
  leafTitle: string,
  leafType: number
): Promise<string> {
  if (leafType === 8) {
    // Leaf and activity titles may differ after a lesson is renamed.
    try {
      const leafUrl = `https://www.yuketang.cn/mooc-api/v1/lms/learn/leaf_info/${classroomId}/${leafId}/?classroom_id=${classroomId}`;
      const leafData = await fetchFromYuketang(leafUrl);
      const leaf = leafData.data;
      const mappedId = leaf?.content_info?.leaf_type_id;
      if (leafData.success !== false && leaf?.leaf_type === 8 && String(leaf.id) === String(leafId) && mappedId && /^\d+$/.test(String(mappedId))) {
        console.log(`[Downloader] Resolved leaf ${leafId} to lessonId ${mappedId} via leaf details`);
        return String(mappedId);
      }
    } catch (err: any) {
      console.warn(`[Downloader] Could not resolve leaf details:`, err.message || err);
    }
    const match = await findActivityInLogs(classroomId, leafTitle, [14]);
    if (match) {
      console.log(`[Downloader] Resolved leaf ${leafId} (${leafTitle}) to lessonId ${match.courseware_id} via logs`);
      return String(match.courseware_id);
    }
  } else if (leafType === 5 || leafType === 9) {
    const targetTypes = leafType === 5 ? [5] : [4, 9, 2];
    const match = await findActivityInLogs(classroomId, leafTitle, targetTypes);
    if (match) {
      console.log(`[Downloader] Resolved exam/homework leaf ${leafId} (${leafTitle}) to courseware_id ${match.courseware_id} via logs`);
      return String(match.courseware_id);
    }
  }
  return leafId;
}

export async function downloadLesson(
  classroomId: string,
  lessonId: string,
  courseName: string,
  lessonIndex: number,
  lessonTitle: string,
  leafType: number = 8
): Promise<void> {
  broadcastProgress(lessonId, 0, "0 KB/s", "pending");

  try {
    const config = await loadConfig();
    const resolvedLessonId = await resolveLessonId(classroomId, lessonId, lessonTitle, leafType);

    if (leafType === 5 || leafType === 9) {
      const cleanCourse = cleanFilename(courseName);
      const cleanTitle = cleanFilename(lessonTitle);
      const targetDir = join(resolve(config.downloadDir), cleanCourse, `${String(lessonIndex).padStart(2, "0")}_${cleanTitle}`);
      await fs.mkdir(targetDir, { recursive: true });

      // Refresh XuetangX authentication automatically
      try {
        console.log(`[Downloader] Refreshing XuetangX auth automatically for exam ${resolvedLessonId} in classroom ${classroomId}...`);
        await refreshXuetangxAuth(classroomId, resolvedLessonId);
      } catch (authErr: any) {
        console.warn(`[Downloader] Automatic XuetangX auth refresh failed:`, authErr.message || authErr);
      }

      let coverData: any = null;
      let logsMatch: any = null;

      try {
        const targetTypes = leafType === 5 ? [5] : [4, 9, 2];
        logsMatch = await findActivityInLogs(classroomId, lessonTitle, targetTypes);
      } catch (err) {
        console.warn(`[Downloader] Failed to fetch logs for cover/attachment resolution:`, err);
      }

      try {
        const coverUrl = `https://examination.xuetangx.com/exam_room/cover?exam_id=${resolvedLessonId}`;
        coverData = await fetchFromXuetangx(coverUrl);
      } catch (err) {
        console.warn(`[Downloader] Failed to fetch exam cover data:`, err);
      }

      let paperData: any = null;
      let resultsData: any = null;

      try {
        const paperUrl = `https://examination.xuetangx.com/exam_room/show_paper?exam_id=${resolvedLessonId}`;
        paperData = await fetchFromXuetangx(paperUrl);
      } catch (err) {
        console.warn(`[Downloader] Failed to fetch exam paper questions:`, err);
      }

      try {
        const resultsUrl = `https://examination.xuetangx.com/exam_room/problem_results?exam_id=${resolvedLessonId}`;
        resultsData = await fetchFromXuetangx(resultsUrl);
      } catch (err) {
        console.warn(`[Downloader] Failed to fetch exam problem results:`, err);
      }

      const title = coverData?.data?.title || logsMatch?.title || lessonTitle;
      const totalScore = coverData?.data?.total_score ?? logsMatch?.total_score ?? "未知";
      const problemCount = coverData?.data?.problem_count ?? logsMatch?.problem_count ?? "未知";
      const deadline = coverData?.data?.deadline 
        ? new Date(coverData.data.deadline).toLocaleString("zh-CN") 
        : (logsMatch?.deadline ? new Date(logsMatch.deadline).toLocaleString("zh-CN") : "无");
      const score = coverData?.data?.result?.score ?? logsMatch?.score ?? "未批改/未提交";
      const desc = coverData?.data?.description || "无描述";

      const attachments = logsMatch?.attachments || [];
      const downloadedFiles: string[] = [];
      if (attachments && attachments.length > 0) {
        broadcastProgress(lessonId, 30, "0 KB/s", "downloading");
        for (let i = 0; i < attachments.length; i++) {
          const att = attachments[i];
          const attUrl = att.url || att.link;
          const attName = att.name || `attachment_${i + 1}`;
          if (attUrl) {
            try {
              const cleanAttName = cleanFilename(attName);
              const destPath = join(targetDir, cleanAttName);
              if (config.offlineMode) {
                await fs.writeFile(destPath, `Offline mock content for attachment: ${attName}`);
              } else {
                const attRes = await fetch(attUrl);
                if (attRes.ok) {
                  const attBuf = Buffer.from(await attRes.arrayBuffer());
                  await fs.writeFile(destPath, attBuf);
                  downloadedFiles.push(cleanAttName);
                }
              }
            } catch (err) {
              console.error(`[Downloader] Failed to download attachment ${attName}:`, err);
            }
          }
        }
      }

      const mdLines = [
        `# ${leafType === 5 ? "考试" : "作业"}详情: ${title}`,
        "",
        `- **课程名称**: ${courseName}`,
        `- **截止日期**: ${deadline}`,
        `- **总分**: ${totalScore}`,
        `- **题目数量**: ${problemCount}`,
        `- **我的得分**: ${score}`,
        `- **描述信息**: ${desc}`,
        ""
      ];

      if (downloadedFiles.length > 0) {
        mdLines.push("## 下载的附件");
        downloadedFiles.forEach(file => {
          mdLines.push(`- [${file}](./${encodeURIComponent(file)})`);
        });
        mdLines.push("");
      }

      const problems = paperData?.data?.problems || [];
      if (problems.length > 0) {
        const resultsMap = new Map<number, any>();
        const resList = resultsData?.data?.problem_results || [];
        for (const res of resList) {
          if (res.problem_id) {
            resultsMap.set(res.problem_id, res);
          }
        }

        mdLines.push("## 试题详情");
        mdLines.push("");

        for (let i = 0; i < problems.length; i++) {
          const p = problems[i];
          const pId = p.ProblemID || p.problem_id;
          const pType = p.Type;
          const pTypeText = p.TypeText || pType;
          const pScore = p.Score || p.score || 0;
          const pBody = cleanHtml(p.Body || "");

          mdLines.push(`### 题 ${i + 1} (${pTypeText} - ${pScore}分)`);
          mdLines.push("");
          mdLines.push(pBody);
          mdLines.push("");

          const options = p.Options || [];
          if (options.length > 0) {
            mdLines.push("**选项**:");
            for (const opt of options) {
              const optKey = opt.key;
              const optVal = cleanHtml(opt.value || "");
              mdLines.push(`- **${optKey}**: ${optVal}`);
            }
            mdLines.push("");
          }

          const res = pId ? resultsMap.get(pId) : null;

          let correctAnsStr = "";
          if (p.Answer) {
            if (Array.isArray(p.Answer)) {
              correctAnsStr = p.Answer.join(", ");
            } else {
              correctAnsStr = String(p.Answer);
            }
          } else if (res && res.answer) {
            if (Array.isArray(res.answer)) {
              correctAnsStr = res.answer.join(", ");
            } else if (typeof res.answer === "object") {
              correctAnsStr = JSON.stringify(res.answer);
            } else {
              correctAnsStr = String(res.answer);
            }
          }

          let myAnsStr = "未作答";
          if (res && res.result !== undefined && res.result !== null) {
            if (Array.isArray(res.result)) {
              myAnsStr = res.result.join(", ");
            } else if (typeof res.result === "object") {
              myAnsStr = JSON.stringify(res.result);
            } else {
              myAnsStr = String(res.result);
            }
          }

          mdLines.push(`- **正确答案**: ${correctAnsStr || "未知"}`);
          mdLines.push(`- **我的作答**: ${myAnsStr}`);

          if (res) {
            const isCorrect = res.correct ? "是" : "否";
            const myScore = res.grade !== undefined ? `${res.grade}分` : "未知";
            mdLines.push(`- **是否正确**: ${isCorrect}`);
            mdLines.push(`- **得分**: ${myScore}`);
          }

          if (p.Remark || p.remark) {
            mdLines.push(`- **解析**: ${cleanHtml(p.Remark || p.remark)}`);
          }

          mdLines.push("");
        }
      } else {
        mdLines.push("> [!WARNING]");
        mdLines.push("> 无法获取试卷详细题目（可能是在线模式下未登录或鉴权失败）。");
        mdLines.push("");
      }

      const mdPath = join(targetDir, `${cleanTitle}.md`);
      await fs.writeFile(mdPath, mdLines.join("\n"), "utf-8");
      console.log(`[Downloader] Exam/Homework saved to ${mdPath}`);

      broadcastProgress(lessonId, 100, "0 KB/s", "completed");
      return;
    }

    const cleanCourse = cleanFilename(courseName);
    const cleanTitle = cleanFilename(lessonTitle);
    const courseDir = join(resolve(config.downloadDir), cleanCourse);
    const problemDir = join(courseDir, "problem");
    await fs.mkdir(problemDir, { recursive: true });

    // 1. Resolve dateStr first
    let dateStr = "";
    let offlineReviewMatch = "";
    if (config.offlineMode) {
      try {
        const reviewsDir = join(process.cwd(), "docs", "reviews", courseName);
        const files = await fs.readdir(reviewsDir);
        let match = files.find(file => file.endsWith(`_${resolvedLessonId}.json`));
        if (!match) {
          const prefix = `${String(lessonIndex).padStart(2, "0")}_`;
          match = files.find(file => file.startsWith(prefix));
        }
        if (!match) {
          const cleanTitlePart = cleanFilename(lessonTitle);
          match = files.find(file => file.includes(cleanTitlePart));
        }
        if (match) {
          offlineReviewMatch = match;
          const dateMatch = match.match(/^\d+_(\d{8})_\d+_/);
          if (dateMatch) {
            dateStr = dateMatch[1];
          }
        }
      } catch {}
    }

    if (!dateStr) {
      try {
        const infoUrl = `https://www.yuketang.cn/api/v3/classroom-report/student/lesson-info?lesson_id=${resolvedLessonId}`;
        const infoData = await fetchFromYuketang(infoUrl);
        const startTimestamp = infoData.data?.start;
        if (startTimestamp) {
          const startDate = new Date(startTimestamp);
          const yyyy = startDate.getFullYear();
          const mm = String(startDate.getMonth() + 1).padStart(2, "0");
          const dd = String(startDate.getDate()).padStart(2, "0");
          dateStr = `${yyyy}${mm}${dd}`;
        }
      } catch (err: any) {
        console.warn(`[Downloader] Could not fetch lesson-info for date:`, err.message || err);
      }
    }

    if (!dateStr && lessonTitle) {
      const titleMatch = lessonTitle.match(/[-_](\d{4})/);
      if (titleMatch) {
        dateStr = `2026${titleMatch[1]}`;
      }
    }

    if (!dateStr) {
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      dateStr = `${yyyy}${mm}${dd}`;
    }

    // 2. Fetch timeline data
    let reviewData: any;
    if (config.offlineMode) {
      if (offlineReviewMatch) {
        try {
          const reviewsDir = join(process.cwd(), "docs", "reviews", courseName);
          const fileData = await fs.readFile(join(reviewsDir, offlineReviewMatch), "utf-8");
          reviewData = JSON.parse(fileData);
          console.log(`[Offline Downloader] Loaded timeline from offline review file: ${offlineReviewMatch}`);
        } catch (err) {
          const reviewUrl = `https://www.yuketang.cn/api/v3/classroom-report/student/review?lesson_id=${resolvedLessonId}`;
          reviewData = await fetchFromYuketang(reviewUrl);
        }
      } else {
        const reviewUrl = `https://www.yuketang.cn/api/v3/classroom-report/student/review?lesson_id=${resolvedLessonId}`;
        reviewData = await fetchFromYuketang(reviewUrl);
      }
    } else {
      const reviewUrl = `https://www.yuketang.cn/api/v3/classroom-report/student/review?lesson_id=${resolvedLessonId}`;
      reviewData = await fetchFromYuketang(reviewUrl);
    }
    const timeline = reviewData.data?.timelineList || [];

    // Group and de-duplicate slides by presentationId and index
    const presentationsMap = new Map<string, Map<number, { cover: string; hasProblem: boolean }>>();
    for (const item of timeline) {
      if (item.type === "slide") {
        const presId = item.presentationId || item.presentation_id || "default";
        const idx = item.index;
        const cover = item.cover;
        if (idx !== undefined && cover) {
          if (!presentationsMap.has(presId)) {
            presentationsMap.set(presId, new Map());
          }
          presentationsMap.get(presId)!.set(idx, { cover, hasProblem: !!item.hasProblem });
        }
      }
    }

    if (presentationsMap.size === 0) {
      throw new Error(`Lesson ${lessonId}: no downloadable slides were returned by the API.`);
    }

    // Determine the order of presentations based on display sequence
    const presOrder: string[] = [];
    for (const item of timeline) {
      if (item.type === "slide") {
        const presId = item.presentationId || item.presentation_id || "default";
        if (!presOrder.includes(presId)) {
          presOrder.push(presId);
        }
      }
    }
    for (const presId of presentationsMap.keys()) {
      if (!presOrder.includes(presId)) {
        presOrder.push(presId);
      }
    }

    const isMultiPres = presOrder.length > 1;

    // Collect all download tasks
    const tasks: (() => Promise<void>)[] = [];
    let totalSlidesCount = 0;
    for (const [_, slidesMap] of presentationsMap.entries()) {
      totalSlidesCount += slidesMap.size;
    }

    let completedCount = 0;
    let totalBytes = 0;
    const startTime = Date.now();

    const downloadedPresentations: {
      targetDir: string;
      folderName: string;
      slidePaths: string[];
    }[] = [];

    for (let presIdx = 0; presIdx < presOrder.length; presIdx++) {
      const presId = presOrder[presIdx];
      const slidesMap = presentationsMap.get(presId);
      if (!slidesMap) continue;

      const sortedIndices = Array.from(slidesMap.keys()).sort((a, b) => a - b);

      // Filter problems and sort them to get sequential numbering for this presentation
      const problemSlides = sortedIndices
        .filter(idx => slidesMap.get(idx)!.hasProblem)
        .map((idx, pIdx) => ({
          slideIndex: idx,
          cover: slidesMap.get(idx)!.cover,
          problemNumber: pIdx + 1
        }));

      // Determine folder name & directory based on isMultiPres
      let folderName: string;
      if (isMultiPres) {
        folderName = `${String(lessonIndex).padStart(2, "0")}_${cleanCourse}_${dateStr}_${presIdx + 1}`;
      } else {
        folderName = `${String(lessonIndex).padStart(2, "0")}_${cleanCourse}_${dateStr}`;
      }

      const targetDir = join(courseDir, folderName);
      await fs.mkdir(targetDir, { recursive: true });

      const slidePaths: string[] = [];
      for (const sIdx of sortedIndices) {
        const slideFileName = join(targetDir, `${String(sIdx).padStart(3, "0")}.jpg`);
        slidePaths.push(slideFileName);

        tasks.push(async () => {
          const slide = slidesMap.get(sIdx)!;
          
          let alreadyExists = false;
          try {
            const stat = await fs.stat(slideFileName);
            if (stat.size > 0) {
              alreadyExists = true;
              totalBytes += stat.size;
            }
          } catch {}

          let imgBuffer: Buffer | null = null;
          if (!alreadyExists) {
            if (config.offlineMode) {
              imgBuffer = MOCK_JPEG;
            } else {
              const imgRes = await fetch(slide.cover, {
                headers: {
                  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                }
              });
              if (!imgRes.ok) {
                throw new Error(`Failed to download slide image from ${slide.cover}`);
              }
              imgBuffer = Buffer.from(await imgRes.arrayBuffer());
            }
            await fs.writeFile(slideFileName, imgBuffer);
            totalBytes += imgBuffer.length;
          }

          // If it is a problem slide, copy/save it to the problem folder
          const pSlide = problemSlides.find(p => p.slideIndex === sIdx);
          if (pSlide) {
            let problemFileName: string;
            if (isMultiPres) {
              problemFileName = join(problemDir, `${String(lessonIndex).padStart(2, "0")}_${presIdx + 1}_${String(pSlide.problemNumber).padStart(2, "0")}.jpg`);
            } else {
              problemFileName = join(problemDir, `${String(lessonIndex).padStart(2, "0")}_${String(pSlide.problemNumber).padStart(2, "0")}.jpg`);
            }

            let pAlreadyExists = false;
            try {
              const stat = await fs.stat(problemFileName);
              if (stat.size > 0) {
                pAlreadyExists = true;
              }
            } catch {}

            if (!pAlreadyExists) {
              if (alreadyExists) {
                await fs.copyFile(slideFileName, problemFileName);
              } else if (imgBuffer) {
                await fs.writeFile(problemFileName, imgBuffer);
              }
            }
          }

          completedCount++;
          const elapsedSec = (Date.now() - startTime) / 1000 || 0.1;
          const rawSpeed = (totalBytes / 1024) / elapsedSec; // KB/s
          const speedStr = rawSpeed > 1024 
            ? `${(rawSpeed / 1024).toFixed(1)} MB/s` 
            : `${rawSpeed.toFixed(0)} KB/s`;
          
          const percent = Math.round((completedCount / totalSlidesCount) * 100);
          broadcastProgress(lessonId, percent, speedStr, "downloading");
        });
      }

      downloadedPresentations.push({ targetDir, folderName, slidePaths });
    }

    // Run tasks with concurrency limit
    const concurrencyLimit = config.concurrency || 5;
    await runWithConcurrency(tasks, concurrencyLimit);

    // Convert slides to PDF/PPTX formats if requested
    for (const pres of downloadedPresentations) {
      await convertToPdfAndPpt(
        pres.targetDir,
        pres.folderName,
        pres.slidePaths,
        !!config.autoConvertPdf,
        !!config.autoConvertPpt
      );
    }

    broadcastProgress(lessonId, 100, "0 KB/s", "completed");
  } catch (err: any) {
    console.error(`[Downloader] Failed to download lesson ${lessonId}:`, err);
    broadcastProgress(lessonId, 0, "0 KB/s", "failed");
    throw err;
  }
}

async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const currentIndex = index++;
      try {
        results[currentIndex] = await tasks[currentIndex]();
      } catch (err) {
        console.error(`[Concurrency] Task ${currentIndex} failed:`, err);
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function convertToPdfAndPpt(
  targetDir: string,
  folderName: string,
  slidePaths: string[],
  convertPdf: boolean,
  convertPpt: boolean
): Promise<void> {
  if (!convertPdf && !convertPpt) return;

  console.log(`[Downloader] Starting conversion for ${folderName}: PDF=${convertPdf}, PPT=${convertPpt}`);

  // Read all slide buffers
  const imgBuffers: Buffer[] = [];
  for (const path of slidePaths) {
    try {
      const buf = await fs.readFile(path);
      if (buf.length > 0) {
        imgBuffers.push(buf);
      }
    } catch (err) {
      console.error(`[Downloader] Error reading slide image ${path}:`, err);
    }
  }

  if (imgBuffers.length === 0) {
    console.warn(`[Downloader] No slide images found for conversion in ${targetDir}`);
    return;
  }

  // 1. Convert to PDF
  if (convertPdf) {
    try {
      const pdfDoc = await PDFDocument.create();
      for (const buf of imgBuffers) {
        const img = await pdfDoc.embedJpg(buf);
        const page = pdfDoc.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      }
      const pdfBytes = await pdfDoc.save();
      const pdfPath = join(targetDir, `${folderName}.pdf`);
      await fs.writeFile(pdfPath, pdfBytes);
      console.log(`[Downloader] Saved PDF to ${pdfPath}`);
    } catch (err: any) {
      console.error(`[Downloader] Failed to generate PDF for ${folderName}:`, err.message || err);
    }
  }

  // 2. Convert to PPTX
  if (convertPpt) {
    try {
      const pptx = new pptxgen();
      pptx.layout = "LAYOUT_16x9";
      for (const buf of imgBuffers) {
        const base64Data = buf.toString("base64");
        const slide = pptx.addSlide();
        slide.addImage({
          data: `image/jpeg;base64,${base64Data}`,
          x: 0,
          y: 0,
          w: "100%",
          h: "100%"
        });
      }
      const pptxPath = join(targetDir, `${folderName}.pptx`);
      await pptx.writeFile({ fileName: pptxPath });
      console.log(`[Downloader] Saved PPTX to ${pptxPath}`);
    } catch (err: any) {
      console.error(`[Downloader] Failed to generate PPTX for ${folderName}:`, err.message || err);
    }
  }
}
