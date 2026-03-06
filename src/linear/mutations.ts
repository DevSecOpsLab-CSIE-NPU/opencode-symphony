export const UPDATE_ISSUE_STATE = `
  mutation UpdateIssueState($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) {
      success
      issue { id state { id name type } }
    }
  }
`;

export const ADD_COMMENT = `
  mutation AddComment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment { id url body }
    }
  }
`;

export const LINK_PR_ATTACHMENT = `
  mutation LinkPRAttachment($issueId: String!, $title: String!, $url: String!) {
    attachmentCreate(input: { issueId: $issueId, title: $title, url: $url }) {
      success
      attachment { id url title }
    }
  }
`;
