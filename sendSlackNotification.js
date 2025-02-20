const { WebClient } = require('@slack/web-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// 환경 변수로부터 Slack 토큰과 채널 ID 가져오기
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const slackClient = new WebClient(SLACK_BOT_TOKEN);

// Slack 채널 검증 함수
async function validateChannel() {
  try {
    const res = await slackClient.conversations.info({
      channel: SLACK_CHANNEL_ID,
    });
    if (!res.channel) throw new Error('채널 정보 없음');
    console.log(`🔍 채널 검증 성공: #${res.channel.name} (ID: ${res.channel.id})`);
  } catch (error) {
    console.error('❌ 채널 검증 실패:', error.message);
    throw error;
  }
}

// 스크린샷 파일 업로드 함수
async function uploadScreenshot(filePath) {
  try {
    // 파일 경로가 존재하지 않으면 절대 경로로 변환
    if (!fs.existsSync(filePath)) {
      filePath = path.join(process.env.GITHUB_WORKSPACE, filePath);
    }
    if (!fs.existsSync(filePath)) throw new Error('파일이 존재하지 않음: ' + filePath);

    const fileContent = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    console.log(`📤 업로드 시도: ${fileName} (${(fileContent.length / 1024).toFixed(2)}KB)`);

    // Slack에 파일 업로드
    const urlResponse = await slackClient.files.getUploadURLExternal({
      filename: fileName,
      length: fileContent.length,
    });
    if (!urlResponse.ok) throw new Error(`업로드 URL 요청 실패: ${urlResponse.error}`);

    const { upload_url, file_id } = urlResponse;
    await axios.post(upload_url, fileContent, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });

    const completeResponse = await slackClient.files.completeUploadExternal({
      files: [{ id: file_id, title: fileName }],
      channel_id: SLACK_CHANNEL_ID,
      initial_comment: `📸 실패 스크린샷: ${fileName}`,
    });
    if (!completeResponse.ok) throw new Error(`파일 처리 실패: ${completeResponse.error}`);

    console.log(`✅ 업로드 성공: ${fileName}`);
    return file_id;
  } catch (error) {
    console.error('❌ 업로드 실패:', error.message);
    throw error;
  }
}

// 재귀적으로 스크린샷 파일을 찾는 함수
// test-results 폴더 내의 하위 폴더(예: 실패 테스트 이름으로 생성된 폴더)에서도 .png 파일을 찾아 반환합니다.
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

// 테스트 결과를 Slack으로 전송하는 메인 함수
async function main() {
  try {
    console.log('🚀 Slack 알림 시스템 시작');
    if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
      throw new Error('SLACK_BOT_TOKEN 또는 SLACK_CHANNEL_ID 환경 변수 누락');
    }

    await validateChannel();

    // Playwright 테스트 결과 파일 읽기
    const reportFilePath = path.join(process.env.GITHUB_WORKSPACE, 'playwright-report', 'playwright-report.json');
    if (!fs.existsSync(reportFilePath)) {
      throw new Error('테스트 결과 파일이 존재하지 않음: ' + reportFilePath);
    }
    const results = JSON.parse(fs.readFileSync(reportFilePath, 'utf-8'));

    // 테스트 결과 통계 계산
    const totalTests = (results.stats.expected || 0) + (results.stats.unexpected || 0);
    const passed = results.stats.expected || 0;
    const failed = results.stats.unexpected || 0;

    let failedTestsDetails = [];

    // 재귀적으로 실패한 테스트 케이스 제목을 수집하는 함수
    function collectFailedTests(suite, resultsArr) {
      if (suite.tests) {
        suite.tests.forEach(test => {
          if (test.status === 'failed' || test.status === 'unexpected') {
            const title = Array.isArray(test.title) ? test.title.join(' ▶ ') : test.title;
            resultsArr.push(`- ${title}`);
          }
          if (test.suites) collectFailedTests(test, resultsArr);
        });
      }
    }

    if (results.suites) {
      results.suites.forEach(suite => collectFailedTests(suite, failedTestsDetails));
    }

    // Slack 메시지 구성
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

    // test-results 디렉토리에서 스크린샷 파일 경로를 수집합니다.
    const screenshotsDir = path.join(process.env.GITHUB_WORKSPACE, 'test-results');
    const screenshotPaths = findScreenshotFiles(screenshotsDir);

    // 실패한 테스트의 스크린샷 업로드
    if (failed > 0 && screenshotPaths.length > 0) {
      console.log(`🔄 실패 스크린샷 처리 시작 (${screenshotPaths.length}개)`);
      for (const filePath of screenshotPaths) {
        await uploadScreenshot(filePath);
        console.log(`🖼️ ${path.basename(filePath)} 처리 완료`);
      }
    } else {
      console.log('📌 전송할 스크린샷 파일이 없습니다.');
    }

    console.log('🎉 모든 작업 완료');
  } catch (error) {
    console.error('💣 치명적 오류:', error.message);
    process.exit(1);
  }
}

main();