const { DefaultArtifactClient } = require('@actions/artifact');
const core = require('@actions/core');
const exec = require('@actions/exec');
const github = require('@actions/github');
const glob = require('@actions/glob');
const { mkdirP } = require('@actions/io');
const lcovTotal = require("lcov-total");
const os = require('os');
const fs = require('fs');
const path = require('path');

const events = ['pull_request', 'pull_request_target'];

async function run() {
  try {
    const tmpPath = path.resolve(os.tmpdir(), github.context.action);
    const coverageFilesPattern = core.getInput('coverage-files');
    const globber = await glob.create(coverageFilesPattern);
    const coverageFiles = await globber.glob();
    const titlePrefix = core.getInput('title-prefix');
    const additionalMessage = core.getInput('additional-message');
    const updateComment = core.getInput('update-comment') === 'true';
    const coverageArtifactName = core.getInput('coverage-artifact-name');

    await genhtml(coverageFiles, tmpPath);

    const coverageFile = await mergeCoverages(coverageFiles, tmpPath);
    const totalCoverage = lcovTotal(coverageFile);
    const gitHubToken = core.getInput('github-token').trim();
    const minimumCoverage = core.getInput('minimum-coverage');
    const errorMessage = `The code coverage is too low: ${totalCoverage}. Expected at least ${minimumCoverage}.`;
    const isMinimumCoverageReached = totalCoverage >= minimumCoverage;

    const hasGithubToken = gitHubToken !== '';
    const isPR = events.includes(github.context.eventName);

    const octokit = await github.getOctokit(gitHubToken);
    if (hasGithubToken && isPR) {
      const summary = await summarize(coverageFile);
      const details = await detail(coverageFile, octokit);
      const previousCoverage = await calculatePreviousCoverage(octokit, coverageArtifactName, gitHubToken, tmpPath);
      const sha = github.context.payload.pull_request.head.sha;
      const shaShort = sha.substr(0, 7);
      const commentHeaderPrefix = `### ${titlePrefix ? `${titlePrefix} ` : ''}[LCOV](https://github.com/marketplace/actions/report-lcov) of commit`;

      let diffMessage = '';
      if (previousCoverage !== null) {
        const compareUrl = `https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/compare/${previousCoverage.targetBranchSha}...${sha}`;
        const diff = totalCoverage - previousCoverage.coverage;
        const diffRounded = diff.toFixed(2);
        const sign = diff > 0 ? '+' : '';
        diffMessage = `This pull request changes total coverage ${sign}${diffRounded}% (${previousCoverage.coverage.toFixed(2)}% -> ${totalCoverage.toFixed(2)}%) for this [diff](${compareUrl})`;
      } else {
        diffMessage = `Total coverage: ${totalCoverage.toFixed(2)}%`;
      }
      let body = `${commentHeaderPrefix} [<code>${shaShort}</code>](${github.context.payload.pull_request.number}/commits/${sha}) during [${github.context.workflow} #${github.context.runNumber}](../actions/runs/${github.context.runId})\n${diffMessage}\n<pre>${summary}\n\nFiles changed coverage rate:${details}</pre>${additionalMessage ? `\n${additionalMessage}` : ''}`;

      if (!isMinimumCoverageReached) {
        body += `\n:no_entry: ${errorMessage}`;
      }

      updateComment ? await upsertComment(body, commentHeaderPrefix, octokit) : await createComment(body, octokit);
    } else if (!hasGithubToken) {
      core.info("github-token received is empty. Skipping writing a comment in the PR.");
      core.info("Note: This could happen even if github-token was provided in workflow file. It could be because your github token does not have permissions for commenting in target repo.")
    } else if (!isPR) {
      core.info("The event is not a pull request. Skipping writing a comment.");
      core.info("The event type is: " + github.context.eventName);
    }

    if (hasGithubToken && coverageArtifactName) {
      core.info("Uploading coverage artifact to the workflow run.");

      const artifactClient = new DefaultArtifactClient();
      await artifactClient.uploadArtifact(
        coverageArtifactName,
        [coverageFile],
        path.dirname(coverageFile),
      );
    } else {
      core.info("Skipping coverage artifact upload.");
    }

    core.setOutput("total-coverage", totalCoverage);

    if (!isMinimumCoverageReached) {
      throw Error(errorMessage);
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

async function createComment(body, octokit) {
  core.debug("Creating a comment in the PR.")

  await octokit.rest.issues.createComment({
    repo: github.context.repo.repo,
    owner: github.context.repo.owner,
    issue_number: github.context.payload.pull_request.number,
    body,
  });
}

async function upsertComment(body, commentHeaderPrefix, octokit) {
  const issueComments = await octokit.rest.issues.listComments({
    repo: github.context.repo.repo,
    owner: github.context.repo.owner,
    issue_number: github.context.payload.pull_request.number,
  });

  const existingComment = issueComments.data.find(comment =>
    comment.body.includes(commentHeaderPrefix),
  );

  if (existingComment) {
    core.debug(`Updating comment, id: ${existingComment.id}.`);

    await octokit.rest.issues.updateComment({
      repo: github.context.repo.repo,
      owner: github.context.repo.owner,
      comment_id: existingComment.id,
      body,
    });
  } else {
    core.debug(`Comment does not exist, a new comment will be created.`);

    await createComment(body, octokit);
  }
}

async function calculatePreviousCoverage(octokit, artifactName, gitHubToken, tmpPath) {
  let coverage;
  try {
    coverage = await downloadTargetBranchCoverage(octokit, artifactName, gitHubToken, tmpPath);
    if (!path) {
      return null;
    }
  } catch (error) {
    core.warning(`Error loading previous coverage: ${error.message}`);
    return null;
  }
  if (!coverage) {
    return null;
  }

  return {
    coverage: lcovTotal(coverage.path),
    ...coverage,
  }
}


async function downloadTargetBranchCoverage(octokit, artifactName, gitHubToken, tmpPath) {
  const pr = github.context.payload.pull_request;
  if (!pr) {
    core.warning("Not a pull request event. Skipping target branch coverage download.");
    return;
  }

  // Use the PR base for the target branch.
  const targetBranch = pr.base.ref;
  core.info(`Searching for a successful workflow run on target branch: ${targetBranch}`);

  const { owner, repo } = github.context.repo;
  const runsResponse = await octokit.rest.actions.listWorkflowRunsForRepo({
    owner,
    repo,
    branch: targetBranch,
    per_page: 1,
  });

  if (runsResponse.data.workflow_runs.length === 0) {
    core.warning(`No successful workflow runs found on branch "${targetBranch}".`);
    return null;
  }

  const workflowRunId = runsResponse.data.workflow_runs[0].id;
  core.info(`Found run id ${workflowRunId} on branch ${targetBranch}.`);

  // Build the findBy object for cross-run artifact download.
  const findBy = {
    token: gitHubToken,
    workflowRunId,
    repositoryOwner: owner,
    repositoryName: repo,
  };

  // Use actions/artifact to download the artifact.
  const artifactClient = new DefaultArtifactClient();
  const artifactInfo = await artifactClient.getArtifact(artifactName, { findBy });
  if (!artifactInfo) {
    core.warning(`No artifact found for "${artifactName}".`);
    return;
  }

  const path = await downloadSingleFileArtifact(artifactName, findBy, `${tmpPath}/${workflowRunId}-${artifactName}-lcov.info`);

  core.info(`Artifact "${artifactName}" downloaded to ${path}.`);
  return {
    path,
    runId: workflowRunId,
    targetBranchSha: runsResponse.data.workflow_runs[0].head_sha,
  }
}

async function downloadSingleFileArtifact(artifactName, findBy, downloadDir) {
  const artifactClient = new DefaultArtifactClient();
  const artifactInfo = await artifactClient.getArtifact(artifactName, { findBy });
  if (!artifactInfo) {
    core.warning(`No artifact found for "${artifactName}".`);
    return;
  }

  // Download the artifact to the specified downloadDir
  await artifactClient.downloadArtifact(artifactInfo.artifact.id, {
    findBy,
    path: downloadDir,
  });
  core.info(`Artifact "${artifactName}" downloaded to ${downloadDir}.`);

  // List files in the download directory
  const files = fs.readdirSync(downloadDir);
  if (files.length !== 1) {
    throw new Error(`Expected a single file, but found ${files.length} files in ${downloadDir}.`);
  }

  // Get the full path of the single file
  const fullFilePath = path.join(downloadDir, files[0]);
  return fullFilePath;
}

async function genhtml(coverageFiles, tmpPath) {
  const workingDirectory = core.getInput('working-directory').trim() || './';
  const artifactName = core.getInput('artifact-name').trim();
  const artifactPath = path.resolve(tmpPath, 'html').trim();
  const args = [...coverageFiles, '--rc', 'lcov_branch_coverage=1'];

  args.push('--output-directory');
  args.push(artifactPath);

  await exec.exec('genhtml', args, { cwd: workingDirectory });

  if (artifactName !== '') {
    const artifact = new DefaultArtifactClient();
    const globber = await glob.create(`${artifactPath}/**/**.*`);
    const htmlFiles = await globber.glob();

    core.info(`Uploading artifacts.`);

    await artifact
      .uploadArtifact(
        artifactName,
        htmlFiles,
        artifactPath,
      );
  } else {
    core.info("Skip uploading artifacts");
  }
}

async function mergeCoverages(coverageFiles, tmpPath) {
  // This is broken for some reason:
  //const mergedCoverageFile = path.resolve(tmpPath, 'lcov.info');
  const mergedCoverageFile = tmpPath + '/lcov.info';
  const args = [];

  for (const coverageFile of coverageFiles) {
    args.push('--add-tracefile');
    args.push(coverageFile);
  }

  args.push('--output-file');
  args.push(mergedCoverageFile);

  await exec.exec('lcov', [...args, '--rc', 'lcov_branch_coverage=1']);

  return mergedCoverageFile;
}

async function summarize(coverageFile) {
  let output = '';

  const options = {};
  options.listeners = {
    stdout: (data) => {
      output += data.toString();
    },
    stderr: (data) => {
      output += data.toString();
    }
  };

  await exec.exec('lcov', [
    '--summary',
    coverageFile,
    '--rc',
    'lcov_branch_coverage=1'
  ], options);

  const lines = output
    .trim()
    .split(/\r?\n/)

  lines.shift(); // Removes "Reading tracefile..."

  return lines.join('\n');
}

async function detail(coverageFile, octokit) {
  let output = '';

  const options = {};
  options.listeners = {
    stdout: (data) => {
      output += data.toString();
    },
    stderr: (data) => {
      output += data.toString();
    }
  };

  await exec.exec('lcov', [
    '--list',
    coverageFile,
    '--list-full-path',
    '--rc',
    'lcov_branch_coverage=1',
  ], options);

  let lines = output
    .trim()
    .split(/\r?\n/)

  lines.shift(); // Removes "Reading tracefile..."
  lines.pop(); // Removes "Total..."
  lines.pop(); // Removes "========"

  const listFilesOptions = octokit
    .rest.pulls.listFiles.endpoint.merge({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number: github.context.payload.pull_request.number,
    });
  const listFilesResponse = await octokit.paginate(listFilesOptions);
  const changedFiles = listFilesResponse.map(file => file.filename);

  lines = lines.filter((line, index) => {
    if (index <= 2) return true; // Include header

    for (const changedFile of changedFiles) {
      console.log(`${line} === ${changedFile}`);

      if (line.startsWith(changedFile)) return true;
    }

    return false;
  });

  if (lines.length === 3) { // Only the header remains
    return ' n/a';
  }

  return '\n  ' + lines.join('\n  ');
}

run();
