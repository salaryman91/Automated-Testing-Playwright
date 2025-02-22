const { WebClient } = require('@slack/web-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const REPORT_URL = process.env.REPORT_URL;
const slackClient = new WebClient(SLACK_BOT_TOKEN);

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

async function main() {
  try {
    console.log('🚀 Slack 알림 시스템 시작');
    if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
      throw new Error('SLACK_BOT_TOKEN 또는 SLACK_CHANNEL_ID 환경 변수 누락');
    }

    await validateChannel();

    const reportFilePath = path.join(process.env.GITHUB_WORKSPACE, 'playwright-report', 'playwright-report.json');
    if (!fs.existsSync(reportFilePath)) {
      throw new Error('테스트 결과 파일이 존재하지 않음: ' + reportFilePath);
    }
    const results = JSON.parse(fs.readFileSync(reportFilePath, 'utf-8'));

    const totalTests = (results.stats.expected || 0) + (results.stats.unexpected || 0);
    const passed = results.stats.expected || 0;
    const failed = results.stats.unexpected || 0;

    let failedTestsDetails = [];

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

    const message = [
      `*🚨 Playwright 테스트 결과*`,
      `• 전체: ${totalTests}`,
      `• 성공: ${passed}`,
      `• 실패: ${failed}`,
      ...(failed > 0 ? ['\n*❌ 실패 케이스:*', ...failedTestsDetails] : []),
      `\n🔗 *테스트 리포트 확인:* <${REPORT_URL}|Playwright 리포트 보기>`,
    ].join('\n');

    await slackClient.chat.postMessage({
      channel: SLACK_CHANNEL_ID,
      text: message,
      mrkdwn: true,
    });

    const screenshotsDir = path.join(process.env.GITHUB_WORKSPACE, 'test-results');
    const screenshotPaths = findScreenshotFiles(screenshotsDir);

    console.log('🎉 모든 작업 완료');
  } catch (error) {
    console.error('💣 치명적 오류:', error.message);
    process.exit(1);
  }
}

main();