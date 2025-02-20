const { WebClient } = require('@slack/web-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const slackClient = new WebClient(SLACK_BOT_TOKEN);

async function validateChannel() {
  const res = await slackClient.conversations.info({ channel: SLACK_CHANNEL_ID });
  if (!res.channel) throw new Error('채널 정보 없음');
  console.log(`🔍 채널 검증 성공: #${res.channel.name} (ID: ${res.channel.id})`);
}

async function uploadScreenshot(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error('파일이 존재하지 않음: ' + filePath);
    }

    const fileContent = fs.readFileSync(filePath);
    const fileName = path.basename(filePath)
      .replace(/[^\w\s.-]/gi, '_')
      .replace(/\s+/g, '_')
      .substring(0, 80);

    console.log(`📤 업로드 시도: ${fileName} (${(fileContent.length / 1024).toFixed(2)}KB)`);

    const urlResponse = await slackClient.files.getUploadURLExternal({
      filename: fileName,
      length: fileContent.length,
    });

    if (!urlResponse.ok) {
      throw new Error(`업로드 URL 요청 실패: ${urlResponse.error}`);
    }
    console.log('🔗 업로드 URL 획득 성공');

    const { upload_url, file_id } = urlResponse;
    await axios.post(upload_url, fileContent, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    console.log('⬆️ 파일 데이터 업로드 완료');

    const completeResponse = await slackClient.files.completeUploadExternal({
      files: [{ id: file_id, title: fileName }],
      channel_id: SLACK_CHANNEL_ID,
      initial_comment: `📸 실패 스크린샷: ${fileName}`,
    });

    if (!completeResponse.ok) {
      throw new Error(`파일 처리 실패: ${completeResponse.error}`);
    }
    console.log(`✅ 업로드 성공: ${fileName}`);
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

    // Playwright JSON 리포트
    const reportFilePath = 'playwright-report/playwright-report.json';
    if (!fs.existsSync(reportFilePath)) {
      throw new Error('테스트 결과 파일이 존재하지 않음: ' + reportFilePath);
    }
    const results = JSON.parse(fs.readFileSync(reportFilePath, 'utf-8'));

    // 통계
    const totalTests = (results.stats.expected || 0) + (results.stats.unexpected || 0);
    const passed = results.stats.expected || 0;
    const failed = results.stats.unexpected || 0;

    let failedTestsDetails = [];
    let screenshotPaths = [];

    if (results.suites) {
      for (const suite of results.suites) {
        if (suite.tests) {
          for (const test of suite.tests) {
            if (test.status === 'unexpected' || test.status === 'failed') {
              failedTestsDetails.push(`- ${test.title.join(' > ')}`);

              // 결과 배열 순회하며 attachments 추출
              if (Array.isArray(test.results)) {
                for (const result of test.results) {
                  if (Array.isArray(result.attachments)) {
                    for (const attachment of result.attachments) {
                      if (
                        attachment.name === 'screenshot' &&
                        attachment.path
                      ) {
                        // 여기서 'test-results' 부분만 추출해서 경로를 normalize
                        const rawPath = attachment.path;
                        const relIndex = rawPath.indexOf('test-results');
                        if (relIndex !== -1) {
                          let relativePath = rawPath.substring(relIndex);
                          // 윈도우 백슬래시 -> 슬래시로
                          relativePath = relativePath.replace(/\\/g, '/');
                          // 최종 경로
                          const finalPath = path.resolve(relativePath);

                          screenshotPaths.push(finalPath);
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // 메시지
    const message = [
      `*🚨 Playwright 테스트 결과*`,
      `• 전체: ${totalTests}`,
      `• 성공: ${passed}`,
      `• 실패: ${failed}`,
      ...(failed > 0 ? ['\n*❌ 실패 케이스:*', ...failedTestsDetails] : []),
    ].join('\n');

    // Slack 메시지 전송
    await slackClient.chat.postMessage({
      channel: SLACK_CHANNEL_ID,
      text: message,
      mrkdwn: true,
    });

    // 스크린샷 업로드
    if (failed > 0 && screenshotPaths.length > 0) {
      console.log(`🔄 실패 스크린샷 처리 시작 (${screenshotPaths.length}개)`);
      for (const filePath of screenshotPaths) {
        await uploadScreenshot(filePath);
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
