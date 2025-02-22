const { WebClient } = require('@slack/web-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;

const slackClient = new WebClient(SLACK_BOT_TOKEN);

// 채널 검증 함수
async function validateChannel() {
  try {
    const res = await slackClient.conversations.info({ channel: SLACK_CHANNEL_ID });
    if (!res.channel) throw new Error('채널 정보 없음');
    console.log(`🔍 채널 검증 성공: #${res.channel.name} (ID: ${res.channel.id})`);
  } catch (error) {
    console.error('❌ 채널 검증 실패:', error.message);
    throw error;
  }
}

// 재귀적으로 .png 스크린샷 파일 찾기
function findScreenshotFiles(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(findScreenshotFiles(filePath));
    } else if (file.toLowerCase().endsWith('.png')) {
      results.push(filePath);
    }
  }
  return results;
}

// 파일 업로드 함수 (HTML 리포트, 스크린샷 등 동일 방식)
// files.getUploadURLExternal 및 files.completeUploadExternal 방식을 사용
async function uploadFile(filePath, initialComment) {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error('파일이 존재하지 않음: ' + filePath);
    }
    const fileName = path.basename(filePath);
    const fileContent = fs.readFileSync(filePath);
    console.log(`📤 업로드 시도: ${fileName} (${(fileContent.length / 1024).toFixed(2)}KB)`);

    // 1. 업로드 URL 요청
    const urlResponse = await slackClient.files.getUploadURLExternal({
      filename: fileName,
      length: fileContent.length,
    });
    if (!urlResponse.ok) {
      throw new Error(`업로드 URL 요청 실패: ${urlResponse.error}`);
    }
    const { upload_url, file_id } = urlResponse;

    // 2. 업로드 URL로 파일 전송
    await axios.post(upload_url, fileContent, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });

    // 3. 업로드 완료 처리
    const completeResponse = await slackClient.files.completeUploadExternal({
      files: [{ id: file_id, title: fileName }],
      channel_id: SLACK_CHANNEL_ID,
      initial_comment: initialComment,
    });
    if (!completeResponse.ok) {
      throw new Error(`파일 처리 실패: ${completeResponse.error}`);
    }
    console.log(`✅ 업로드 성공: ${fileName}`);
    return file_id;
  } catch (error) {
    console.error('❌ 업로드 실패:', error.message);
    throw error;
  }
}

async function main() {
  try {
    console.log('🚀 Slack 알림 시스템 시작');
    if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
      throw new Error('SLACK_BOT_TOKEN 또는 SLACK_CHANNEL_ID 환경 변수 누락');
    }
    await validateChannel();

    // Playwright JSON 리포트 파일 읽기
    const reportJsonPath = path.join(process.env.GITHUB_WORKSPACE || __dirname, 'playwright-report', 'playwright-report.json');
    if (!fs.existsSync(reportJsonPath)) {
      throw new Error('테스트 결과 파일이 존재하지 않음: ' + reportJsonPath);
    }
    const results = JSON.parse(fs.readFileSync(reportJsonPath, 'utf-8'));

    const totalTests = (results.stats.expected || 0) + (results.stats.unexpected || 0);
    const passed = results.stats.expected || 0;
    const failed = results.stats.unexpected || 0;

    // 실패 케이스 수집
    const failedTestsDetails = [];
    function collectFailedTests(suite, arr) {
      if (suite.tests) {
        suite.tests.forEach(test => {
          if (test.status === 'failed' || test.status === 'unexpected') {
            const title = Array.isArray(test.title) ? test.title.join(' ▶ ') : test.title;
            arr.push(`- ${title}`);
          }
          if (test.suites) {
            collectFailedTests(test, arr);
          }
        });
      }
    }
    if (results.suites) {
      results.suites.forEach(suite => collectFailedTests(suite, failedTestsDetails));
    }

    // Slack 메시지 전송
    const message = [
      `*🚨 Playwright 테스트 결과*`,
      `• 전체: ${totalTests}`,
      `• 성공: ${passed}`,
      `• 실패: ${failed}`,
      ...(failed > 0 ? ['\n*❌ 실패 케이스:*', ...failedTestsDetails] : []),
    ].join('\n');

    await slackClient.chat.postMessage({
      channel: SLACK_CHANNEL_ID,
      text: message,
      mrkdwn: true,
    });

    // HTML 리포트 파일 업로드 (index.html)
    const reportHtmlPath = path.join(process.env.GITHUB_WORKSPACE || __dirname, 'playwright-report', 'index.html');
    if (fs.existsSync(reportHtmlPath)) {
      await uploadFile(reportHtmlPath, `📊 Playwright 테스트 리포트 (index.html)`);
    } else {
      console.log('📌 HTML 리포트 파일이 없습니다.');
    }

    // 실패한 테스트가 있을 경우, 스크린샷 파일 업로드
    if (failed > 0) {
      const screenshotsDir = path.join(process.env.GITHUB_WORKSPACE || __dirname, 'test-results');
      const screenshotPaths = findScreenshotFiles(screenshotsDir);
      if (screenshotPaths.length > 0) {
        console.log(`🔄 실패 스크린샷 처리 시작 (${screenshotPaths.length}개)`);
        for (const filePath of screenshotPaths) {
          await uploadFile(filePath, `📸 실패 스크린샷: ${path.basename(filePath)}`);
        }
      } else {
        console.log('📌 전송할 스크린샷 파일이 없습니다.');
      }
    }

    console.log('🎉 모든 작업 완료');
  } catch (error) {
    console.error('💣 치명적 오류:', error.message);
    process.exit(1);
  }
}

main();
