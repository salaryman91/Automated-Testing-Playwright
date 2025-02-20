/************************************************************
 * Slack로 Playwright 테스트 결과 & 실패 스크린샷 전송하기
 * 
 * - playwright-report/playwright-report.json 파일을 기반으로
 *   전체/성공/실패 통계, 실패 케이스 목록, 스크린샷 경로를 파싱.
 * - test-results 폴더에 저장된 스크린샷 파일을 Slack에 업로드.
 ************************************************************/

const { WebClient } = require('@slack/web-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// (1) 환경 변수로부터 Slack 인증 정보 가져오기
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;

// (2) Slack WebClient 인스턴스 생성
const slackClient = new WebClient(SLACK_BOT_TOKEN);

/************************************************************
 * Slack 채널 유효성 검증
 ************************************************************/
async function validateChannel() {
  try {
    const res = await slackClient.conversations.info({
      channel: SLACK_CHANNEL_ID,
      include_num_members: false,
    });
    if (!res.channel) {
      throw new Error('채널 정보가 없습니다.');
    }
    console.log(`🔍 채널 검증 성공: #${res.channel.name} (ID: ${res.channel.id})`);
  } catch (error) {
    console.error('❌ 채널 검증 실패:', error.message);
    throw error;
  }
}

/************************************************************
 * 파일(스크린샷) 업로드 함수
 ************************************************************/
async function uploadScreenshot(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`파일이 존재하지 않음: ${filePath}`);
    }

    // 파일 로드
    const fileContent = fs.readFileSync(filePath);
    const fileName = path
      .basename(filePath)
      .replace(/[^\w\s.-]/gi, '_')
      .replace(/\s+/g, '_')
      .substring(0, 80);

    console.log(`📤 업로드 시도: ${fileName} (${(fileContent.length / 1024).toFixed(2)}KB)`);

    // (1) 업로드 URL 요청
    const urlResponse = await slackClient.files.getUploadURLExternal({
      filename: fileName,
      length: fileContent.length,
    });

    if (!urlResponse.ok) {
      throw new Error(`업로드 URL 요청 실패: ${urlResponse.error}`);
    }
    console.log('🔗 업로드 URL 획득 성공');

    // (2) 업로드
    const { upload_url, file_id } = urlResponse;
    await axios.post(upload_url, fileContent, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    console.log('⬆️ 파일 데이터 업로드 완료');

    // (3) 업로드 완료 처리 & Slack 채널에 파일 연결
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

/************************************************************
 * 메인 실행 함수
 ************************************************************/
async function main() {
  try {
    console.log('🚀 Slack 알림 시스템 시작');

    // (1) 환경 변수 체크
    if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
      throw new Error('SLACK_BOT_TOKEN 또는 SLACK_CHANNEL_ID 환경 변수가 누락되었습니다.');
    }
    console.log('🔐 환경변수 체크:', {
      token: SLACK_BOT_TOKEN ? '****' + SLACK_BOT_TOKEN.slice(-4) : '미설정',
      channel: SLACK_CHANNEL_ID || '미설정',
    });

    // (2) 채널 유효성 검증
    await validateChannel();

    // (3) Playwright JSON 리포트 파일 읽기
    //    기본적으로 "playwright-report/playwright-report.json" 위치에 생성된다고 가정
    const reportFilePath = path.join('playwright-report', 'playwright-report.json');
    if (!fs.existsSync(reportFilePath)) {
      throw new Error(`테스트 결과 파일이 존재하지 않습니다: ${reportFilePath}`);
    }
    const results = JSON.parse(fs.readFileSync(reportFilePath, 'utf-8'));

    // (4) 테스트 통계 계산
    //     Playwright JSON 리포트의 stats: { expected, unexpected } 구조
    const totalTests = ((results.stats.expected || 0) + (results.stats.unexpected || 0)) || 0;
    const passed = results.stats.expected || 0;
    const failed = results.stats.unexpected || 0;

    // (5) 실패 케이스 목록 & 스크린샷 경로 추출
    let failedTestsDetails = [];
    let screenshotPaths = [];

    if (results.suites && Array.isArray(results.suites)) {
      for (const suite of results.suites) {
        if (suite.tests && Array.isArray(suite.tests)) {
          for (const test of suite.tests) {
            // Playwright에선 실패를 "unexpected"라고 기록
            if (test.status === 'unexpected' || test.status === 'failed') {
              // 테스트 제목: 배열 형태 -> join으로 연결
              failedTestsDetails.push(`- ${test.title.join(' > ')}`);

              // test.results 배열을 순회하며 attachments 확인
              if (Array.isArray(test.results)) {
                for (const result of test.results) {
                  if (result.attachments && Array.isArray(result.attachments)) {
                    for (const attachment of result.attachments) {
                      // name: "screenshot" && path: "test-results/..."
                      if (
                        attachment.name === 'screenshot' &&
                        attachment.path &&
                        attachment.path.includes('test-results')
                      ) {
                        screenshotPaths.push(attachment.path);
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

    // (6) Slack 메시지 작성
    const message = [
      `*🚨 Playwright 테스트 결과*`,
      `• 전체: ${totalTests}`,
      `• 성공: ${passed}`,
      `• 실패: ${failed}`,
      ...(failed > 0
        ? ['\n*❌ 실패 케이스:*', ...failedTestsDetails]
        : [])
    ].join('\n');

    // (7) Slack 채널에 결과 전송
    await slackClient.chat.postMessage({
      channel: SLACK_CHANNEL_ID,
      text: message,
      mrkdwn: true, // 마크다운 지원
    });

    // (8) 실패 시 스크린샷 파일 전송
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

// (9) 스크립트 실행
main();
