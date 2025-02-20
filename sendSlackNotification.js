const { WebClient } = require('@slack/web-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// 환경 변수로부터 Slack 토큰과 채널 ID 가져오기
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
    // 만약 파일이 존재하지 않으면 Windows 절대 경로일 가능성이 있으므로, "test-results" 이하만 추출
    if (!fs.existsSync(filePath)) {
      const index = filePath.indexOf('test-results');
      if (index !== -1) {
        let relativePath = filePath.substring(index);
        // 백슬래시(\)를 슬래시(/)로 치환
        relativePath = relativePath.replace(/\\/g, '/');
        // CI 환경에서 절대 경로로 변환
        filePath = path.resolve(relativePath);
        console.log(`경로 변환 후: ${filePath}`);
      }
    }
    if (!fs.existsSync(filePath)) throw new Error('파일이 존재하지 않음: ' + filePath);

    const fileContent = fs.readFileSync(filePath);
    const fileName = path
      .basename(filePath)
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
    console.log('🔐 환경변수 체크:', {
      token: SLACK_BOT_TOKEN ? '****' + SLACK_BOT_TOKEN.slice(-4) : '미설정',
      channel: SLACK_CHANNEL_ID || '미설정',
    });

    await validateChannel();

    // Playwright JSON 리포트 읽기 (상대 경로 사용)
    const reportFilePath = path.join('playwright-report', 'playwright-report.json');
    if (!fs.existsSync(reportFilePath)) {
      throw new Error('테스트 결과 파일이 존재하지 않음: ' + reportFilePath);
    }
    const results = JSON.parse(fs.readFileSync(reportFilePath, 'utf-8'));

    // 통계: Playwright는 stats에 expected와 unexpected 필드를 사용합니다.
    const totalTests = (results.stats.expected || 0) + (results.stats.unexpected || 0);
    const passed = results.stats.expected || 0;
    const failed = results.stats.unexpected || 0;

    let failedTestsDetails = [];
    let screenshotPaths = [];

    // JSON 리포트에서 suites > tests 구조를 순회
    if (results.suites && Array.isArray(results.suites)) {
      for (const suite of results.suites) {
        if (suite.tests && Array.isArray(suite.tests)) {
          for (const test of suite.tests) {
            // 실패 케이스는 보통 test.ok === false 혹은 test.status가 'unexpected' 또는 'failed'
            if (test.ok === false || test.status === 'failed' || test.status === 'unexpected') {
              // test.title가 문자열이면 그대로, 배열이면 join
              const testTitle = typeof test.title === 'string' ? test.title : test.title.join(' > ');
              failedTestsDetails.push(`- ${testTitle}`);

              // 각 테스트 내의 sub 테스트 결과 확인 (test.tests 배열)
              if (Array.isArray(test.tests)) {
                for (const subTest of test.tests) {
                  if (subTest.status === 'unexpected' || subTest.status === 'failed') {
                    // subTest.results 배열에서 attachments 확인
                    if (Array.isArray(subTest.results)) {
                      for (const result of subTest.results) {
                        if (Array.isArray(result.attachments)) {
                          for (const attachment of result.attachments) {
                            if (attachment.name === 'screenshot' && attachment.path) {
                              // 윈도우 경로인 경우 "test-results" 이하만 추출
                              let attPath = attachment.path;
                              const idx = attPath.indexOf('test-results');
                              if (idx !== -1) {
                                attPath = attPath.substring(idx).replace(/\\/g, '/');
                                attPath = path.resolve(attPath);
                              }
                              if (fs.existsSync(attPath)) {
                                screenshotPaths.push(attPath);
                              } else {
                                console.log(`파일 없음: ${attPath}`);
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
        }
      }
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
