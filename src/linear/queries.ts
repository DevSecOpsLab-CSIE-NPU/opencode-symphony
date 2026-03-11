export const GET_ACTIVE_ISSUES = `
  query GetActiveIssues($teamIds: [ID!], $states: [String!]) {
    issues(filter: {
      team: { id: { in: $teamIds } }
      state: { name: { in: $states } }
    }) {
      nodes {
        id
        identifier
        title
        url
        description
        state { id name type }
        priority
        assignee { id name }
        labels { nodes { name } }
        updatedAt
        createdAt
      }
    }
  }
`;

export const GET_ACTIVE_ISSUES_ALL_TEAMS = `
  query GetActiveIssuesAllTeams($states: [String!]) {
    issues(filter: {
      state: { name: { in: $states } }
    }) {
      nodes {
        id
        identifier
        title
        url
        description
        state { id name type }
        priority
        assignee { id name }
        labels { nodes { name } }
        updatedAt
        createdAt
      }
    }
  }
`;

export const GET_ISSUE = `
  query GetIssue($id: String!) {
    issue(id: $id) {
      id identifier title url
      description
      state { id name type }
      priority
      assignee { id name }
      labels { nodes { name } }
      updatedAt
      createdAt
    }
  }
`;

export const GET_WORKFLOW_STATES = `
  query GetWorkflowStates($teamId: String!) {
    workflowStates(filter: { team: { id: { eq: $teamId } } }) {
      nodes { id name type }
    }
  }
`;
