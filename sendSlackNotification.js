const { WebClient } = require('@slack/web-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Slack 토큰과 채널 ID를 환경 변수에서 가져옴
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const slackClient = new WebClient(SLACK_BOT_TOKEN);

// Slack 채널이 유효한지 확인
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

// 스크린샷 파일을 Slack에 업로드
async function uploadScreenshot(filePath) {
  try {
    // 파일 경로가 존재하지 않으면 절대 경로로 변환
    if (!path.isAbsolute(filePath)) {
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

// 디렉토리를 재귀적으로 순회하며 특정 패턴의 파일 찾기
function findFilesRecursively(dir, pattern) {
  let results = [];
  
  // 디렉토리 읽기
  try {
    const items = fs.readdirSync(dir);
    
    for (const item of items) {
      const itemPath = path.join(dir, item);
      const stat = fs.statSync(itemPath);
      
      if (stat.isDirectory()) {
        // 하위 디렉토리 재귀 탐색
        results = results.concat(findFilesRecursively(itemPath, pattern));
      } else if (stat.isFile() && item.match(pattern)) {
        // 패턴에 맞는 파일 추가
        results.push(itemPath);
      }
    }
  } catch (err) {
    console.error(`디렉토리 읽기 오류 (${dir}):`, err.message);
  }
  
  return results;
}

// 실패한 테스트의 스크린샷 찾기
function findFailedTestScreenshots() {
  try {
    const testResultsDir = path.join(process.env.GITHUB_WORKSPACE, 'test-results');
    if (!fs.existsSync(testResultsDir)) {
      console.warn('⚠️ test-results 디렉토리가 존재하지 않습니다.');
      return [];
    }
    
    // -failed.png로 끝나는 파일 찾기
    const screenshotPaths = findFilesRecursively(testResultsDir, /-failed\.png$/);
    
    console.log(`🔍 발견된 실패 스크린샷: ${screenshotPaths.length}개`);
    return screenshotPaths;
  } catch (error) {
    console.error('❌ 스크린샷 검색 실패:', error.message);
    return [];
  }
}

// results.json 파일을 읽거나 테스트 요약 생성
function getTestResults() {
  try {
    // Playwright 테스트 결과 파일 읽기 시도
    const reportFilePath = path.join(process.env.GITHUB_WORKSPACE, 'playwright-report', 'results.json');
    if (fs.existsSync(reportFilePath)) {
      return JSON.parse(fs.readFileSync(reportFilePath, 'utf-8'));
    }
    
    // 기본 report.json 찾기 시도
    const defaultReportPath = path.join(process.env.GITHUB_WORKSPACE, 'playwright-report', 'report.json');
    if (fs.existsSync(defaultReportPath)) {
      return JSON.parse(fs.readFileSync(defaultReportPath, 'utf-8'));
    }
    
    // playwright-report.json 시도
    const playwrightReportPath = path.join(process.env.GITHUB_WORKSPACE, 'playwright-report', 'playwright-report.json');
    if (fs.existsSync(playwrightReportPath)) {
      return JSON.parse(fs.readFileSync(playwrightReportPath, 'utf-8'));
    }
    
    // 결과 파일이 없으면 test-results 디렉토리에서 실패 정보 수집
    console.log('⚠️ 테스트 결과 파일을 찾을 수 없어 디렉토리 구조에서 정보를 수집합니다.');
    
    // 테스트 결과 디렉토리 확인
    const testResultsDir = path.join(process.env.GITHUB_WORKSPACE, 'test-results');
    if (!fs.existsSync(testResultsDir)) {
      throw new Error('test-results 디렉토리가 존재하지 않습니다.');
    }
    
    // 브라우저 프로젝트 디렉토리 검색
    const browserDirs = fs.readdirSync(testResultsDir)
      .filter(dir => {
        const dirPath = path.join(testResultsDir, dir);
        return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
      });
    
    // 각 브라우저 프로젝트에서 실패한 테스트 수집
    let failedTests = [];
    let totalTests = 0;
    
    browserDirs.forEach(browser => {
      const browserPath = path.join(testResultsDir, browser);
      const testDirs = fs.readdirSync(browserPath)
        .filter(dir => {
          const dirPath = path.join(browserPath, dir);
          return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
        });
      
      totalTests += testDirs.length;
      
      testDirs.forEach(testDir => {
        const testPath = path.join(browserPath, testDir);
        try {
          const files = fs.readdirSync(testPath);
          
          // 실패 스크린샷이 있는지 확인
          const hasFailedScreenshot = files.some(file => file.includes('-failed.png'));
          
          if (hasFailedScreenshot) {
            failedTests.push(`- ${browser}: ${testDir.replace(/-/g, ' ')}`);
          }
        } catch (err) {
          console.warn(`테스트 디렉토리 읽기 오류 (${testPath}):`, err.message);
        }
      });
    });
    
    return {
      stats: {
        total: totalTests,
        passed: totalTests - failedTests.length,
        failed: failedTests.length
      },
      failedTests
    };
  } catch (error) {
    console.error('❌ 테스트 결과 처리 실패:', error.message);
    return {
      stats: { total: 0, passed: 0, failed: 0 },
      failedTests: []
    };
  }
}

// 테스트 결과를 Slack으로 전송
async function main() {
  try {
    console.log('🚀 Slack 알림 시스템 시작');
    if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
      throw new Error('SLACK_BOT_TOKEN 또는 SLACK_CHANNEL_ID 환경 변수 누락');
    }

    await validateChannel();
    
    // 테스트 결과 수집
    const results = getTestResults();
    const totalTests = results.stats.total;
    const passed = results.stats.passed;
    const failed = results.stats.failed;
    
    // 실패한 테스트 케이스 목록
    const failedTestsDetails = results.failedTests || [];
    
    // 실패 스크린샷 찾기
    const screenshotPaths = findFailedTestScreenshots();

    // Slack 메시지 구성
    const message = [
      `*🚨 Playwright 테스트 결과*`,
      `• 전체: ${totalTests}`,
      `• 성공: ${passed}`,
      `• 실패: ${failed}`,
      ...(failedTestsDetails.length > 0 ? ['\n*❌ 실패 케이스:*', ...failedTestsDetails] : []),
    ].join('\n');

    await slackClient.chat.postMessage({
      channel: SLACK_CHANNEL_ID,
      text: message,
      mrkdwn: true,
    });

    // 실패한 테스트의 스크린샷 업로드
    if (screenshotPaths.length > 0) {
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