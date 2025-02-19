const { WebClient } = require('@slack/web-api');
const fs = require('fs');
const path = require('path');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const slackClient = new WebClient(SLACK_BOT_TOKEN);

async function sendSlackMessage(message) {
  await slackClient.chat.postMessage({
    channel: SLACK_CHANNEL_ID,
    text: message,
    mrkdwn: true,
  });
}

async function main() {
  try {
    console.log('Slack 알림 시작');

    const message = '*Playwright 테스트 결과*\n' +
                    '테스트가 완료되었습니다. 결과를 확인해 주세요.';
    await sendSlackMessage(message);

    console.log('Slack 메시지 전송 완료');
  } catch (error) {
    console.error('Slack 알림 전송 중 오류 발생:', error);
  }
}

main();
