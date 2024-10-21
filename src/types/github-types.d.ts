import { RestEndpointMethodTypes } from "@octokit/rest";
import { Context } from "./context";

export type Issue = RestEndpointMethodTypes["issues"]["get"]["response"]["data"];
export type Comments =
  | RestEndpointMethodTypes["issues"]["listComments"]["response"]["data"]
  | RestEndpointMethodTypes["pulls"]["listReviewComments"]["response"]["data"];
export type User = RestEndpointMethodTypes["users"]["getByUsername"]["response"]["data"];

//Modify the Issue add User Type
export type IssueWithUser = Issue & { user: User };

export type FetchParams = {
  context: Context;
  issueNum?: number;
  owner?: string;
  repo?: string;
};

export type LinkedIssues = {
  issueNumber: number;
  repo: string;
  owner: string;
  url: string;
  comments?: SimplifiedComment[] | null | undefined;
  body?: string;
};

export type SimplifiedComment = {
  user: User | Partial<User>;
  body: string;
  id: string;
  org: string;
  repo: string;
  issueUrl: string;
};

export type FetchedCodes = {
  body: string;
  user: User | Partial<User>;
  issueUrl: string;
  id: string;
  org: string;
  repo: string;
  issueNumber: number;
};
