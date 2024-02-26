const core = require('@actions/core');
const simpleGit = require('simple-git');
const path = require('path');
const { readFile } = require('fs').promises;
const { retry } = require('@octokit/plugin-retry');
const { GitHub, getOctokitOptions } = require('@actions/github/lib/utils');

const { getReposList, createPr, getRepo, createBranch, getFile, fileExists, commitFiles } = require('./api-calls');
const { getListOfFilesToReplicate, getListOfReposToIgnore, getBranchName, encodeAdditions, encodeDeletions } = require('./utils');

const triggerEventName = process.env.GITHUB_EVENT_NAME;
const eventPayload = require(process.env.GITHUB_EVENT_PATH);

/* eslint-disable sonarjs/cognitive-complexity */
async function run() {
  const isPush = triggerEventName === 'push';
  if (isPush) core.info('Workflow started on push event');
  const isWorkflowDispatch = triggerEventName === 'workflow_dispatch';
  if (isWorkflowDispatch) core.info('Workflow started on workflow_dispatch event');

  if (!isPush && !isWorkflowDispatch) return core.setFailed('This GitHub Action works only when triggered by "push" or "workflow_dispatch" webhooks.');
  
  core.debug('DEBUG: full payload of the event that triggered the action:');
  core.debug(JSON.stringify(eventPayload, null, 2));

  try {
    /*
     * 0. Setting up necessary variables and getting input specified by workflow user
    */ 
    const gitHubKey = process.env.GITHUB_TOKEN || core.getInput('github_token', { required: true });
    const patternsToIgnore = core.getInput('patterns_to_ignore');
    const patternsToInclude = core.getInput('patterns_to_include');
    const patternsToRemove = core.getInput('patterns_to_remove');
    const commitMessage = core.getInput('commit_message');
    const branches = core.getInput('branches');
    const destination = core.getInput('destination');
    const customBranchName = core.getInput('bot_branch_name');
    const repoNameManual = eventPayload.inputs && eventPayload.inputs.repo_name;

    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');

    const octokit = GitHub.plugin(retry);
    const myOctokit = new octokit(getOctokitOptions(gitHubKey, {
      // Topics are currently only available using mercy-preview.
      previews: ['mercy-preview'],
    }));

    //Id of commit can be taken only from push event, not workflow_dispatch
    //TODO for now this action is hardcoded to always get commit id of the first commit on the list
    const commitId = triggerEventName === 'push' ? eventPayload.commits[0].id : '';

    if (patternsToRemove && patternsToInclude) {
      core.setFailed('Fields patterns_to_include and patterns_to_remove are mutually exclusive. If you want to remove files from repos then do not use patterns_to_include.');
      return;
    }

    if (patternsToRemove && destination) 
      core.warning('The destination field will be ignored as it doesn\'t make sense when removal is expected and patterns_to_remove field is used');

    /*
     * 1. Getting list of files that have changes that must be replicated in other repos
     * If `patterns_to_remove` field is used then this step is ommited as there is no need to search for files to replicate as no replication takes place but removal
     */
    let filesToCheckForReplication;
    let filesToReplicate;
    let filesToRemove;
    if (!patternsToRemove) {
      filesToCheckForReplication = await getListOfFilesToReplicate(myOctokit, commitId, owner, repo, patternsToIgnore, patternsToInclude, triggerEventName);
      filesToReplicate = filesToCheckForReplication.filesForReplication;
      filesToRemove = filesToCheckForReplication.filesForRemoval;
      //if no files need replication, we just need to stop the workflow from further execution
      if (!filesToReplicate.length && !filesToRemove.length) 
        return;
    } 
    //filesForReplication
    //filesThatNeedToBeRemoved

    /*
     * 2. Getting list of all repos owned by the owner/org 
     *    or just replicating to the one provided manually
     */
    let reposList = [];
    if (isWorkflowDispatch && repoNameManual) {
      reposList.push(await getRepo(myOctokit, owner, repoNameManual));
    } else {
      reposList = await getReposList(myOctokit, owner);
    }

    /*
     * 3. Getting list of repos that should be ignored
     */
    const ignoredRepositories = getListOfReposToIgnore(repo, reposList, {
      reposToIgnore: core.getInput('repos_to_ignore'),
      topicsToInclude: core.getInput('topics_to_include'),
      excludePrivate: (core.getInput('exclude_private') === 'true'),
      excludeForked: (core.getInput('exclude_forked') === 'true'),
    });

    /*
     * 4. Management of files in selected repos starts one by one
     */
    for (const repo of reposList) {
      try {
        //start only if repo not on list of ignored
        if (!ignoredRepositories.includes(repo.name)) {        
          core.startGroup(`Started updating ${repo.name} repo`);
          const defaultBranch = repo.defaultBranch;

          /*
           * 4a. Check for differences via API between files in github and those we wanna commit
           */
          let fileChanges = {};

          for (const path of filesToReplicate) {
            const targetContentsBefore = await getFile(myOctokit, owner, repo.name, defaultBranch, path);
            const sourceContents = await readFile(process.cwd() + '/' + path);

            core.debug(`DEBUG: sourceContents of ${path} file`);
            core.debug(sourceContents.toString());
            core.debug(`DEBUG: targetContentsBefore of ${path} file`);
            core.debug(targetContentsBefore.toString());
            
            if (sourceContents.toString() !== targetContentsBefore.toString()) {
              if (fileChanges["additions"] == null)
                fileChanges["additions"] = [];
              fileChanges["additions"].push(encodeAdditions(filesToReplicate, destination));
            }
          }

          for (const path in filesToRemove) {
            if (await fileExists(myOctokit, owner, repo.name, defaultBranch, path)) {
              if (fileChanges["deletions"] == null)
                fileChanges["deletions"] = [];
              fileChanges["deletions"].push(encodeDeletions(filesToRemove, destination));
            }
          }

          if (fileChanges["additions"] || fileChanges["deletions"]) {
            /*
            * 4b. Use API call to create a branch
            */
            const newBranchName = getBranchName(customBranchName, commitId);
            
            const wasBranchThereAlready = await createBranch(myOctokit, owner, repo.name, newBranchName, defaultBranch);
            if (wasBranchThereAlready) {
              core.info(`Branch ${newBranchName} already exists in the ${repo.name} repo`);
            } else {
              core.info(`Branch ${newBranchName} was created in the ${repo.name} repo`);
            }

            /*
            * 4c. Use API call to create a commit in that branch
            */
            commitUrl = await commitFiles(myOctokit, owner, repo.name, newBranchName, fileChanges, commitMessage);
            core.info(`Commit was created in the ${repo.name} repo -> ${commitUrl}`);


            /*
              * 4fe. Opening a PR. Doing in try/catch as it is not always failing because of timeouts, maybe branch already has a PR
              * we need to try to create a PR cause there can be branch but someone closed PR, so branch is there but PR not
              */
            let pullRequestUrl;
            try {
              pullRequestUrl = await createPr(myOctokit, newBranchName, repo.id, commitMessage, defaultBranch);
            } catch (error) {
              if (wasBranchThereAlready)
                core.info(`PR creation for ${repo.name} failed as the branch was there already. Insted only push was performed to existing ${newBranchName} branch`, error);
            }

            core.endGroup();
        
            if (pullRequestUrl) {
              core.info(`Workflow finished with success and PR for ${repo.name} is created -> ${pullRequestUrl}`);
            } else if (!pullRequestUrl && wasBranchThereAlready) {
              core.info(`Workflow finished without PR creation for ${repo.name}. Insted push was performed to existing ${newBranchName} branch`);
            } else {
              core.info(`Unable to create a PR because of timeouts. Create PR manually from the branch ${newBranchName} that was already created in the upstream`);
            }
          }
          else {
            core.info(`No changes in repo ${repo.name} detected`);
            core.endGroup();
          }
        }
      } catch (error) {
        core.endGroup();
        core.warning(`Failed replicating files for this repo: ${error}`);
        continue;
      }
    }
  } catch (error) {
    core.setFailed(`Action failed because of: ${error}`);
  }
}

run();
