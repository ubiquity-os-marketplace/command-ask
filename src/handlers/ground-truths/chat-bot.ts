import { Context } from "../../types";
import { RepoLanguages } from "../../types/github-types";

export async function fetchRepoDependencies(context: Context) {
  const {
    octokit,
    payload: {
      repository: {
        owner: { login: owner },
        name: repo,
      },
    },
    logger,
  } = context;

  try {
    const { data: packageJson } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: "package.json",
    });

    if ("content" in packageJson) {
      return extractDependencies(JSON.parse(Buffer.from(packageJson.content, "base64").toString()));
    }
  } catch (err) {
    logger.error(`Error fetching package.json for ${owner}/${repo}`, { err });
  }
  return {
    dependencies: {},
    devDependencies: {},
  };
}

export function extractDependencies(packageJson: Record<string, Record<string, string>>) {
  const { dependencies, devDependencies } = packageJson;

  return {
    dependencies,
    devDependencies,
  };
}

export async function fetchRepoLanguageStats(context: Context) {
  const {
    octokit,
    payload: {
      repository: {
        owner: { login: owner },
        name: repo,
      },
    },
    logger,
  } = context;
  try {
    const { data: languages } = (await octokit.rest.repos.listLanguages({
      owner,
      repo,
    })) as { data: RepoLanguages };

    const totalBytes = Object.values(languages).reduce((acc, bytes) => acc + bytes, 0);

    const stats = Object.entries(languages).reduce(
      (acc, [language, bytes]) => {
        acc[language] = bytes / totalBytes;
        return acc;
      },
      {} as Record<string, number>
    );

    return Array.from(Object.entries(stats)).sort((a, b) => b[1] - a[1]);
  } catch (err) {
    logger.error(`Error fetching language stats for ${owner}/${repo}`, { err });
    return [];
  }
}
