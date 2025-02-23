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

    // 파일 경로에서 정보 추출 개선
    const pathParts = absolutePath.split(path.sep);
    const testDirName = pathParts.find(part => part.startsWith('test-')) || '';

    // 전체 경로에서 브라우저 정보 찾기
    let browser = 'unknown';
    if (absolutePath.includes('chromium')) browser = 'chromium';
    else if (absolutePath.includes('firefox')) browser = 'firefox';
    else if (absolutePath.includes('webkit')) browser = 'webkit';

    // 테스트 이름 추출 및 정리
    const testName = testDirName
      .replace(/^test-/, '') // 앞의 'test-' 제거
      .split('-')
      .filter(part => !['test', 'failed', '1', browser].includes(part)) // 불필요한 부분 제거
      .join('-');

    const fileName = `${testName}-${browser}.png`;

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

    const processTest = (test, parentTitle = '') => {
      if (test.status === 'failed' || test.status === 'unexpected') {
        const testTitle = test.title || parentTitle;
        const browser = test.projectName || 'Unknown Browser';
        // 테스트 제목과 브라우저 정보를 결합
        results.push(`- ${testTitle} ${browser}`);
      }
    };

    const processSpec = (spec, parentTitle = '') => {
      if (spec.tests) {
        spec.tests.forEach(test => processTest(test, spec.title || parentTitle));
      } else if (spec.status === 'failed' || spec.status === 'unexpected') {
        results.push(`- ${spec.title || 'Unnamed Test'}`);
      }
    };

    const processSuite = (currentSuite) => {
      if (currentSuite.specs) {
        currentSuite.specs.forEach(spec => processSpec(spec, currentSuite.title));
      }
      if (currentSuite.tests) {
        currentSuite.tests.forEach(test => processTest(test, currentSuite.title));
      }
      if (currentSuite.suites) {
        currentSuite.suites.forEach(subSuite => processSuite(subSuite));
      }
    };

    processSuite(suite);
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

    if (unexpected > 0 && results.suites) {
      const failedTests = results.suites.flatMap(suite => SlackNotifier.collectFailedTests(suite));
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