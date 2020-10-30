'use strict';

const _ = require('lodash')
const validate = require('jsonschema').validate
const schema = require('./schema.json');

class ServerlessPlugin {
  constructor(serverless, options) {
    this.eventBridgeCrossOrganization = null;
    this.serverless = serverless;
    this.eventBridgeIamRole = 'CrossOrganizationEventBridgeRole';

    this.hooks = {
      'before:package:initialize':  this.compileIamRoleStatementsToEventBridge.bind(this),
      'after:package:initialize':  this.compile.bind(this)
    };
  }

  compile() {
    this.eventBridgeCrossOrganization = _.get(this.serverless, 'service.custom.eventBridgeCrossOrganization');

    if (!this.eventBridgeCrossOrganization) return;

    const validated = validate(this.eventBridgeCrossOrganization, schema);

    if (validated.errors.length > 0) {
      throw validated.errors.join('\n');
    }

    if (this.eventBridgeCrossOrganization.receiveEvents) {
      this.compileReceiver();
    } 

    if (this.eventBridgeCrossOrganization.sendEvents) {
      this.compileSender();
    } 
  }

  compileReceiver() {
    const { organizationId, statementId } = this.eventBridgeCrossOrganization.receiveEvents;
    const alphaNumericStatementId = statementId.replace(/[^a-z0-9+]+/gi, '');

    const template = {
      "EventBusPolicyCrossOrganization": {
        "Type": "AWS::Events::EventBusPolicy",
        "Properties": {
          "Action": "events:PutEvents",
          "Principal": "*",
          "EventBusName": "default",
          "StatementId": alphaNumericStatementId,
          "Condition": {
            "Type": "StringEquals",
            "Key": "aws:PrincipalOrgID",
            "Value": organizationId
          }
        }
      }
    };

    _.merge(this.serverless.service.provider.compiledCloudFormationTemplate.Resources, template)
  }

  compileSender() {
    this.compileIamRoleToEventBridge();
    this.compileRulesToEventBridge();
  }

  compileIamRoleStatementsToEventBridge() {
    const template = {
      "Effect": "Allow",
      "Action": [
        "events:PutEvents"
      ],
      "Resource": "*"
    }

    if (_.isArray(_.get(this.serverless, 'service.provider.iamRoleStatements'))) {
      this.serverless.service.provider.iamRoleStatements.push(template);
    } else {
      this.serverless.service.provider.iamRoleStatements = [template];
    }
  }

  compileIamRoleToEventBridge() {
    const template = {
      [this.eventBridgeIamRole]: {
        "Type": "AWS::IAM::Role",
        "Properties": {
          "AssumeRolePolicyDocument": {
            "Statement": [
              {
                "Effect": "Allow",
                "Principal": {
                  "Service": [
                    "events.amazonaws.com"
                  ]
                },
                "Action": [
                  "sts:AssumeRole"
                ]
              }
            ]
          },
          "ManagedPolicyArns": [
            "arn:aws:iam::aws:policy/AmazonEventBridgeFullAccess"
          ]
        }
      }
    }

    _.merge(this.serverless.service.provider.compiledCloudFormationTemplate.Resources, template)
  }

  compileRulesToEventBridge() {
    const targetAccounts = this.eventBridgeCrossOrganization.sendEvents;
    const rulesTemplate = targetAccounts.map(account => {
      const eventBusName = account.eventBusName;
      const ruleName = account.ruleName || `EventRuleCase${account.targetAccountId}`;
      const alphaNumericRuleName = ruleName.replace(/[^a-z0-9+]+/gi, '');

      return {
        [alphaNumericRuleName]: {
          "Type" : "AWS::Events::Rule",
          "Properties" : {
            "Name" : alphaNumericRuleName,
            "EventBusName" : eventBusName || "default",
            "EventPattern" : account.pattern,
            "State" : "ENABLED",
            "Targets" : [
              {
                "Arn": `arn:aws:events:eu-central-1:${account.targetAccountId}:event-bus/default`,
                "RoleArn": {"Fn::GetAtt": [this.eventBridgeIamRole, "Arn"]},
                "Id": `targetId_${account.targetAccountId}`
              }
            ]
          }
        }
      }
    });

    _.merge(this.serverless.service.provider.compiledCloudFormationTemplate.Resources, ...rulesTemplate)
  }

}

module.exports = ServerlessPlugin;
