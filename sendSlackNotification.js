const { WebClient } = require('@slack/web-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const slackClient = new WebClient(SLACK_BOT_TOKEN);

async function validateChannel() {
  try {
    const res = await slackClient.conversations.info({
      channel: SLACK_CHANNEL_ID,
      include_num_members: false,
    });
    if (!res.channel) throw new Error('채널 정보 없음');
    console.log(`🔍 채널 검증 성공: #${res.channel.name} (ID: ${res.channel.id})`);
  } catch (error) {
    console.error('❌ 채널 검증 실패:', error.message);
    throw error;
  }
}

async function uploadScreenshot(filePath) {
  try {
    if (!fs.existsSync(filePath)) throw new Error('파일이 존재하지 않음: ' + filePath);

    const fileContent = fs.readFileSync(filePath);
    const fileName = path.basename(filePath)
      .replace(/[^\w\s.-]/gi, '_')
      .replace(/\s+/g, '_')
      .substring(0, 80);

    console.log(`📤 업로드 시도: ${fileName} (${(fileContent.length / 1024).toFixed(2)}KB)`);

    // 1. 업로드 URL 요청
    const urlResponse = await slackClient.files.getUploadURLExternal({
      filename: fileName,
      length: fileContent.length,
    });

    if (!urlResponse.ok) {
      throw new Error(`업로드 URL 요청 실패: ${urlResponse.error}`);
    }
    console.log('🔗 업로드 URL 획득 성공');

    // 2. 파일 데이터 업로드
    const { upload_url, file_id } = urlResponse;
    await axios.post(upload_url, fileContent, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    console.log('⬆️ 파일 데이터 업로드 완료');

    // 3. 업로드 완료 처리 및 Slack에 파일 등록
    const completeResponse = await slackClient.files.completeUploadExternal({
      files: [{ id: file_id, title: fileName }],
      channel_id: SLACK_CHANNEL_ID,
      initial_comment: `📸 실패 스크린샷: ${fileName}`,
    });

    if (!completeResponse.ok) {
      throw new Error(`파일 처리 실패: ${completeResponse.error}`);
    }
    console.log(`✅ 업로드 성공: ${fileName}`);
    return file_id;
  } catch (error) {
    console.error('❌ 업로드 실패:', {
      file: path.basename(filePath),
      slack_error: error.response?.data?.error,
      error_code: error.response?.status,
    });
    throw error;
  }
}

async function main() {
  try {
    console.log('🚀 Slack 알림 시스템 시작');
    if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
      throw new Error('SLACK_BOT_TOKEN 또는 SLACK_CHANNEL_ID 환경 변수 누락');
    }
    console.log('🔐 환경변수 체크:', {
      token: SLACK_BOT_TOKEN ? '****' + SLACK_BOT_TOKEN.slice(-4) : '미설정',
      channel: SLACK_CHANNEL_ID || '미설정',
    });
    await validateChannel();

    // Playwright JSON 리포트 파일 읽기 (로컬 경로에 맞게 수정)
    const reportFilePath = './playwright-report/playwright-report.json';
    if (!fs.existsSync(reportFilePath)) {
      throw new Error('테스트 결과 파일이 존재하지 않음: ' + reportFilePath);
    }
    const results = JSON.parse(fs.readFileSync(reportFilePath, 'utf-8'));

    const totalTests = results.stats.tests || 0;
    const passed = results.stats.passed || 0;
    const failed = results.stats.failed || 0;

    let failedTestsDetails = [];
    let screenshotPaths = [];

    // JSON 리포트에서 각 스위트와 테스트 케이스 순회
    if (results.suites && Array.isArray(results.suites)) {
      results.suites.forEach((suite) => {
        if (suite.tests && Array.isArray(suite.tests)) {
          suite.tests.forEach((test) => {
            if (test.status === 'unexpected' || test.status === 'failed') {
              failedTestsDetails.push(`- ${test.title.join(' > ')}`);
              // 각 테스트의 결과에서 첨부파일 검색 (스크린샷)
              test.results.forEach((result) => {
                if (result.attachments && Array.isArray(result.attachments)) {
                  result.attachments.forEach((attachment) => {
                    if (
                      attachment.name === 'screenshot' &&
                      attachment.path &&
                      attachment.path.includes('test-results')
                    ) {
                      screenshotPaths.push(attachment.path);
                    }
                  });
                }
              });
            }
          });
        }
      });
    }

    const message = [
      `*🚨 Playwright 테스트 결과*`,
      `• 전체: ${totalTests}`,
      `• 성공: ${passed}`,
      `• 실패: ${failed}`,
      ...(failed > 0 ? ['\n*❌ 실패 케이스:*', ...failedTestsDetails] : []),
    ].join('\n');

    // 테스트 결과 메시지 전송
    await slackClient.chat.postMessage({
      channel: SLACK_CHANNEL_ID,
      text: message,
      mrkdwn: true,
    });

    // 실패한 테스트가 있을 경우 스크린샷 전송
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
    console.error('💣 치명적 오류:', {
      message: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
}

main();
