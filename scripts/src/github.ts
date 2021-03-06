/* eslint-disable @typescript-eslint/explicit-function-return-type */

import * as core from '@actions/core'
import {Octokit} from '@octokit/rest'
import {graphql} from '@octokit/graphql'
import {retry} from '@octokit/plugin-retry'
import {throttling} from '@octokit/plugin-throttling'
import {createAppAuth} from '@octokit/auth-app'
import {env} from './utils'
import {graphql as GraphQL} from '@octokit/graphql/dist-types/types' // eslint-disable-line import/no-unresolved
import {GetResponseDataTypeFromEndpointMethod} from '@octokit/types' // eslint-disable-line import/named

const Client = Octokit.plugin(retry, throttling)
const Endpoints = new Octokit()
type Repositories = GetResponseDataTypeFromEndpointMethod<
  typeof Endpoints.repos.listForOrg
>
type Teams = GetResponseDataTypeFromEndpointMethod<typeof Endpoints.teams.list>

export class GitHub {
  static github: GitHub
  static async getGitHub(): Promise<GitHub> {
    if (GitHub.github === undefined) {
      const auth = createAppAuth({
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_APP_PEM_FILE
      })
      const installationAuth = await auth({
        type: 'installation',
        installationId: env.GITHUB_APP_INSTALLATION_ID
      })
      GitHub.github = new GitHub(installationAuth.token)
    }
    return GitHub.github
  }

  client: Octokit
  graphqlClient: GraphQL

  private constructor(token: string) {
    this.client = new Client({
      auth: token,
      throttle: {
        onRateLimit: (
          retryAfter: number,
          options: {method: string; url: string; request: {retryCount: number}}
        ) => {
          core.warning(
            `Request quota exhausted for request ${options.method} ${options.url}`
          )

          if (options.request.retryCount === 0) {
            // only retries once
            core.info(`Retrying after ${retryAfter} seconds!`)
            return true
          }
        },
        onSecondaryRateLimit: (
          retryAfter: number,
          options: {method: string; url: string; request: {retryCount: number}}
        ) => {
          core.warning(
            `SecondaryRateLimit detected for request ${options.method} ${options.url}`
          )

          if (options.request.retryCount === 0) {
            // only retries once
            core.info(`Retrying after ${retryAfter} seconds!`)
            return true
          }
        }
      }
    })
    this.graphqlClient = graphql.defaults({
      headers: {
        authorization: `token ${token}`
      }
    })
  }

  async listMembers() {
    core.info('Listing members...')
    return this.client.paginate(this.client.orgs.listMembers, {
      org: env.GITHUB_ORG
    })
  }

  private repositories?: Repositories
  async listRepositories() {
    if (!this.repositories) {
      core.info('Listing repositories...')
      this.repositories = await this.client.paginate(
        this.client.repos.listForOrg,
        {
          org: env.GITHUB_ORG
        }
      )
    }
    return this.repositories
  }

  private teams?: Teams
  async listTeams() {
    if (!this.teams) {
      core.info('Listing teams...')
      this.teams = await this.client.paginate(this.client.teams.list, {
        org: env.GITHUB_ORG
      })
    }
    return this.teams
  }

  async listRepositoryCollaborators() {
    const repositoryCollaborators = []
    const repositories = await this.listRepositories()
    for (const repository of repositories) {
      core.info(`Listing ${repository.name} collaborators...`)
      const collaborators = await this.client.paginate(
        this.client.repos.listCollaborators,
        {owner: env.GITHUB_ORG, repo: repository.name, affiliation: 'direct'}
      )
      repositoryCollaborators.push(
        ...collaborators.map(collaborator => ({repository, collaborator}))
      )
    }
    return repositoryCollaborators
  }

  async listRepositoryBranchProtectionRules() {
    // https://github.com/octokit/graphql.js/issues/61
    const repositoryBranchProtectionRules = []
    const repositories = await this.listRepositories()
    for (const repository of repositories) {
      core.info(`Listing ${repository.name} branch protection rules...`)
      const {
        repository: {
          branchProtectionRules: {nodes}
        }
      }: {repository: {branchProtectionRules: {nodes: {pattern: string}[]}}} =
        await this.graphqlClient(
          `
          {
            repository(owner: "${env.GITHUB_ORG}", name: "${repository.name}") {
              branchProtectionRules(first: 100) {
                nodes {
                  pattern
                }
              }
            }
          }
        `
        )
      repositoryBranchProtectionRules.push(
        ...nodes.map(node => ({repository, branchProtectionRule: node}))
      )
    }
    return repositoryBranchProtectionRules
  }

  async listTeamMembers() {
    const teamMembers = []
    const teams = await this.listTeams()
    for (const team of teams) {
      core.info(`Listing ${team.name} members...`)
      const members = await this.client.paginate(
        this.client.teams.listMembersInOrg,
        {org: env.GITHUB_ORG, team_slug: team.slug}
      )
      teamMembers.push(...members.map(member => ({team, member})))
    }
    return teamMembers
  }

  async listTeamRepositories() {
    const teamRepositories = []
    const teams = await this.listTeams()
    for (const team of teams) {
      core.info(`Listing ${team.name} repositories...`)
      const repositories = await this.client.paginate(
        this.client.teams.listReposInOrg,
        {org: env.GITHUB_ORG, team_slug: team.slug}
      )
      teamRepositories.push(
        ...repositories.map(repository => ({team, repository}))
      )
    }
    return teamRepositories
  }

  async getRepositoryFile(repository: string, path: string) {
    core.info(`Checking if ${repository}/${path} exists...`)
    try {
      return (
        await this.client.repos.getContent({
          owner: env.GITHUB_ORG,
          repo: repository,
          path
        })
      ).data as {path: string; url: string}
    } catch (e) {
      core.debug(JSON.stringify(e))
      return undefined
    }
  }
}
