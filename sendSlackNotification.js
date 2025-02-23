const { WebClient } = require('@slack/web-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

class SlackNotifier {
  constructor(token, channelId) {
    if (!token || !channelId) {
      throw new Error('SLACK_BOT_TOKEN 또는 SLACK_CHANNEL_ID 환경 변수 누락');
    }
    this.client = new WebClient(token);
    this.channelId = channelId;
  }

  async validateChannel() {
    const { channel } = await this.client.conversations.info({ channel: this.channelId });
    if (!channel) throw new Error('채널 정보 없음');
    console.log(`🔍 채널 검증 성공: #${channel.name}`);
  }

  async uploadScreenshot(filePath) {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(process.env.GITHUB_WORKSPACE, filePath);
    if (!fs.existsSync(absolutePath)) throw new Error(`파일이 존재하지 않음: ${absolutePath}`);

    const fileContent = fs.readFileSync(absolutePath);
    const fileName = `${path.basename(path.dirname(absolutePath))}-${path.basename(absolutePath)}`;

    const { upload_url, file_id } = await this.client.files.getUploadURLExternal({
      filename: fileName,
      length: fileContent.length,
    });

    await axios.post(upload_url, fileContent, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });

    await this.client.files.completeUploadExternal({
      files: [{ id: file_id, title: fileName }],
      channel_id: this.channelId,
      initial_comment: `📸 실패 스크린샷: ${fileName}`,
    });

    console.log(`✅ 업로드 성공: ${fileName}`);
    return file_id;
  }

  static findScreenshotFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { recursive: true })
      .filter(file => file.toLowerCase().endsWith('.png'))
      .map(file => path.join(dir, file));
  }

  static collectFailedTests(suite) {
    const results = [];
    const processTests = (tests, projectName = 'Unknown Browser') => {
      tests.forEach(test => {
        if (test.status === 'failed' || test.status === 'unexpected') {
          const title = Array.isArray(test.title) ? test.title.join(' ▶ ') : test.title;
          results.push(`- ${title} ▶ ${test.projectName || projectName}`);
        }
      });
    };

    if (suite.specs) {
      suite.specs.forEach(spec => {
        if (spec.tests) processTests(spec.tests);
        else if (spec.status === 'failed' || spec.status === 'unexpected') {
          results.push(`- ${spec.title}`);
        }
      });
    }

    if (suite.tests) processTests(suite.tests);
    if (suite.suites) suite.suites.forEach(subSuite => {
      results.push(...this.collectFailedTests(subSuite));
    });

    return results;
  }

  async sendTestResults(reportPath) {
    const absoluteReportPath = path.isAbsolute(reportPath) 
      ? reportPath 
      : path.join(process.env.GITHUB_WORKSPACE, reportPath);

    if (!fs.existsSync(absoluteReportPath)) {
      throw new Error(`테스트 결과 파일이 존재하지 않음: ${absoluteReportPath}`);
    }

    const results = JSON.parse(fs.readFileSync(absoluteReportPath, 'utf-8'));
    const { expected = 0, unexpected = 0 } = results.stats;
    const totalTests = expected + unexpected;

    const message = [
      `*🚨 Playwright 테스트 결과*`,
      `• 전체: ${totalTests}`,
      `• 성공: ${expected}`,
      `• 실패: ${unexpected}`,
    ];

    if (unexpected > 0) {
      const failedTests = results.suites
        ? results.suites.flatMap(suite => SlackNotifier.collectFailedTests(suite))
        : [];
      if (failedTests.length) {
        message.push('\n*❌ 실패 케이스:*', ...failedTests);
      }
    }

    await this.client.chat.postMessage({
      channel: this.channelId,
      text: message.join('\n'),
      mrkdwn: true,
    });

    return unexpected;
  }

  async processScreenshots(screenshotsDir) {
    const screenshots = SlackNotifier.findScreenshotFiles(screenshotsDir);
    if (screenshots.length === 0) {
      console.log('📌 전송할 스크린샷 파일이 없습니다.');
      return;
    }

    console.log(`🔄 실패 스크린샷 처리 시작 (${screenshots.length}개)`);
    for (const screenshot of screenshots) {
      await this.uploadScreenshot(screenshot);
      console.log(`🖼️ ${path.basename(screenshot)} 처리 완료`);
    }
  }
}

async function main() {
  try {
    console.log('🚀 Slack 알림 시스템 시작');
    
    const notifier = new SlackNotifier(
      process.env.SLACK_BOT_TOKEN,
      process.env.SLACK_CHANNEL_ID
    );

    await notifier.validateChannel();

    const reportPath = path.join('playwright-report', 'playwright-report.json');
    const failedTests = await notifier.sendTestResults(reportPath);

    if (failedTests > 0) {
      await notifier.processScreenshots(path.join(process.env.GITHUB_WORKSPACE, 'test-results'));
    }

    console.log('🎉 모든 작업 완료');
  } catch (error) {
    console.error('💣 치명적 오류:', error.message);
    process.exit(1);
  }
}

main();