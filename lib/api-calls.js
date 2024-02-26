const core = require('@actions/core');

module.exports = { getCommitFiles, getReposList, createPr, getRepo, createBranch, getFile, fileExists, commitFiles };

async function getCommitFiles(octokit, commitId, owner, repo) {
  const { data: { files } } = await octokit.repos.getCommit({
    owner,
    repo,
    ref: commitId
  });

  return files;
}

async function getRepo(octokit, owner, repo) {
  core.info(`Getting details of manually selected ${repo} repository`);

  const { data } = await octokit.repos.get({
    owner,
    repo
  });

  const repoDetails = {
    name: data.name,
    url: data.html_url,
    id: data.node_id,
    defaultBranch: data.default_branch,
    private: data.private,
    fork: data.fork,
    archived: data.archived,
    topics: data.topics,
  };

  core.debug(`DEBUG: Repo ${repo} full response`);
  core.debug(JSON.stringify(data, null, 2));
  core.debug(`DEBUG: Repo ${repo} response that will be returned`);
  core.debug(JSON.stringify(repoDetails, null, 2));

  return repoDetails;
}

async function getReposList(octokit, owner) {
  let isUser;
  let response;

  core.startGroup(`Getting list of all repositories owned by ${owner}`);
  /*
  * Checking if action runs for organization or user as then to list repost there are different api calls
  */
  try {
    await octokit.orgs.get({
      org: owner,
    });

    isUser = false;
  } catch (error) {
    if (error.status === 404) {
      try {
        await octokit.users.getByUsername({
          username: owner,
        });
        isUser = true;
      } catch (error) {
        throw new Error(`Invalid user/org: ${  error}`);
      }
    } else {
      throw new Error(`Failed checking if workflow runs for org or user: ${  error}`);
    }
  }

  /*
  * Getting list of repos
  */
  if (isUser) {
    response = await octokit.paginate(octokit.repos.listForUser, {
      username: owner,
      per_page: 100
    });
  } else {
    response = await octokit.paginate(octokit.repos.listForOrg, {
      org: owner,
      per_page: 100
    });
  }

  const reposList = response.map((repo) => {
    return {
      name: repo.name,
      url: repo.html_url,
      id: repo.node_id,
      defaultBranch: repo.default_branch,
      private: repo.private,
      fork: repo.fork,
      archived: repo.archived,
      topics: repo.topics,
    };
  });

  core.debug(`DEBUG: list of repositories for ${owner}:`);
  core.debug(JSON.stringify(reposList, null, 2));
  core.endGroup();

  return reposList;
}

async function createPr(octokit, branchName, id, commitMessage, defaultBranch) {
  const createPrMutation =
    `mutation createPr($branchName: String!, $id: ID!, $commitMessage: String!, $defaultBranch: String!) {
      createPullRequest(input: {
        baseRefName: $defaultBranch,
        headRefName: $branchName,
        title: $commitMessage,
        repositoryId: $id
      }){
        pullRequest {
          url
        }
      }
    }
    `;

  const newPrVariables = {
    branchName,
    id,
    commitMessage,
    defaultBranch
  };

  let retries = 5;
  let count = 0;

  while (retries-- > 0) {
    count++;
    try {
      core.info('Waiting 5sec before PR creation');
      await sleep(5000);
      core.info(`PR creation attempt ${count}`);
      const { createPullRequest: { pullRequest: { url: pullRequestUrl } } } = await octokit.graphql(createPrMutation, newPrVariables);
      retries = 0;
      return pullRequestUrl;
    } catch (error) {
      //if error is different than rate limit/timeout related we should throw error as it is very probable that
      //next PR will also fail anyway, we should let user know early in the process by failing the action
      if (error.message !== 'was submitted too quickly') {
        throw new Error(`Unable to create a PR: ${  error}`);
      }
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

async function createBranch(octokit, owner, repo, newBranchName, defaultBranch) {
  core.info(`Creating branch ${newBranchName} in the ${repo} repository`);
  
  const r = await getRefOidAndRepoId(octokit, owner, repo, defaultBranch);
  const headOid = r[0];
  const repoId = r[1];

  const createRefMutation = `
    mutation createRef($repoId: ID!, $ref: String!, $oid: GitObjectID!) {
      createRef(input: {name: $ref, oid: $oid, repositoryId: $repoId}) {
        ref {
          name
        }
      }
    }
  `;

  try {
    await octokit.graphql(createRefMutation, {
      repoId: repoId,
      ref: `refs/heads/${newBranchName}`,
      oid: headOid
    });
    return false;
  } catch (error) {
    if (error.status === 422) {
      core.info(`Branch ${newBranchName} already exists in the ${repo} repository`);
      return true;
    } else {
      throw new Error(`Unable to create a branch ${newBranchName} in the ${repo} repository: ${  error}`);
    }
  }
}

async function getFile(octokit, owner, repo, ref, path) {
  try {
    return await octokit.repos.getContent({
      owner,
      repo,
      path,
      ref
    });
  } catch (error) {
    if (error.status === 404) {
      return false;
    } else {
      throw new Error(`Unable to check if file ${path} exists in the ${repo} repository: ${  error}`);
    }
  }
}

async function fileExists(octokit, owner, repo, ref, path) {
  const file = await getFile(octokit, owner, repo, ref, path);
  return file !== false;
}

async function commitFiles(octokit, owner, repo, branch, fileChanges, commitMessage) {
  core.info(`Committing changes to the ${repo} repository`);


  const createCommitQuery = `
    mutation($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) {
        commit {
          url
        }
      }
    }
  `;

  let tries = 10;
  let response = null;

  while (tries > 0) {
    try {
      const r = await getRefOidAndRepoId(octokit, owner, repo, branch);
      const headOid = r[0];

      const inputs = { 
        input: {
          branch: {
            repositoryNameWithOwner: `${owner}/${repo}`,
            branchName: branch
          },
          fileChanges: fileChanges,
          message: { headline: commitMessage },
          expectedHeadOid: headOid
        }
      }

      core.debug(`DEBUG: Commit request`);
      core.debug(createCommitQuery);
      core.debug(JSON.stringify(inputs, null, 2));

      response = await octokit.graphql(createCommitQuery, inputs)

      core.debug(`DEBUG: Commit response`);
      core.debug(JSON.stringify(response, null, 2));

      if (response == null)
        throw new Error('Response is null');

      return response["createCommitOnBranch"]["commit"]["url"];

    } catch (error) {
      if (error.message === 'Response is null') {
        await sleep(1000);
        tries--;
      } else {
        throw new Error(`Unable to commit changes to the ${repo} repository: ${  error}`);
      }
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

async function getRefOidAndRepoId(octokit, owner, repo, branch){
  const headOidQuery =`
    query($owner: String!, $name: String!, $ref: String!) { 
      repository(owner: $owner, name: $name) {
        id
        ref(qualifiedName: $ref) {
          target {
            oid
          }
        }
      }
    }
  `;

  const ref = `refs/heads/${branch}`;
  const response = await octokit.graphql(headOidQuery, {owner: owner, name: repo, ref: ref})

  const headOid = response["repository"]["ref"]["target"]["oid"];
  const repoId = response["repository"]["id"];

  return [headOid, repoId];
}
