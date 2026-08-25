// Talks to the AWS Cognito user pool Kwikset's app uses for login. Built on
// `amazon-cognito-identity-js` (AWS's own, officially maintained client
// library), configured against Kwikset's pool - see const.js for where
// those IDs came from and the caveats around them.
//
// Kwikset's pool uses Cognito's CUSTOM_AUTH flow. For accounts that require
// phone verification, authenticateUser doesn't succeed immediately - it
// fires a "custom challenge" callback. The answer to that first challenge
// (a magic string, not a code) tells Kwikset's backend to text a
// verification code to the phone on file; the SECOND custom-challenge round
// is where that code actually gets checked, via another magic string with
// the code appended. This two-step shape is specific to how Kwikset wired
// up their Cognito Lambda triggers - it was reverse-engineered (not
// invented here) from the homebridge-kwikset-halo plugin, see const.js.

import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoRefreshToken,
} from "amazon-cognito-identity-js";
import {
  COGNITO_USER_POOL_ID,
  COGNITO_USER_POOL_CLIENT_ID,
} from "./const.js";

const userPool = new CognitoUserPool({
  UserPoolId: COGNITO_USER_POOL_ID,
  ClientId: COGNITO_USER_POOL_CLIENT_ID,
});

function sessionToTokens(session) {
  return {
    idToken: session.getIdToken().getJwtToken(),
    accessToken: session.getAccessToken().getJwtToken(),
    refreshToken: session.getRefreshToken().getToken(),
  };
}

/**
 * Log in with email + password. If the account requires phone
 * verification, `getVerificationCode` is awaited to obtain the SMS code -
 * omit it only for accounts you're sure don't have this enabled.
 *
 * @param {string} email
 * @param {string} password
 * @param {{getVerificationCode?: () => Promise<string>}} [opts]
 * @returns {Promise<{email: string, idToken: string, accessToken: string, refreshToken: string}>}
 */
export function login(email, password, opts = {}) {
  const { getVerificationCode } = opts;
  const cognitoUser = new CognitoUser({ Username: email, Pool: userPool });
  const authDetails = new AuthenticationDetails({
    Username: email,
    Password: password,
  });

  return new Promise((resolve, reject) => {
    let challengeRound = 0;

    const onSuccess = (session) => resolve({ email, ...sessionToTokens(session) });
    const onFailure = (err) => reject(err);

    const customChallenge = async () => {
      challengeRound += 1;

      if (challengeRound === 1) {
        // Round 1: tell Kwikset to text a code to the phone on file.
        cognitoUser.sendCustomChallengeAnswer(
          "answerType:generateCode,medium:phone,codeType:login",
          { onSuccess, onFailure, customChallenge }
        );
        return;
      }

      // Round 2 (or later, e.g. a wrong code prompting a retry): verify
      // the code the user has by now received.
      if (!getVerificationCode) {
        reject(
          new Error(
            "This Kwikset account requires phone verification (a texted " +
              "code), but no getVerificationCode callback was supplied."
          )
        );
        return;
      }

      try {
        const code = await getVerificationCode();
        cognitoUser.sendCustomChallengeAnswer(
          `answerType:verifyCode,medium:phone,codeType:login,code:${code}`,
          { onSuccess, onFailure, customChallenge }
        );
      } catch (err) {
        reject(err);
      }
    };

    cognitoUser.authenticateUser(authDetails, {
      onSuccess,
      onFailure,
      customChallenge,
    });
  });
}

/**
 * Exchange a saved refresh token for a fresh session. Cognito access/ID
 * tokens are short-lived (about an hour), so the MCP server calls this on
 * every connect rather than trying to reuse a possibly-stale ID token.
 *
 * @param {string} email
 * @param {string} refreshToken
 */
export function refresh(email, refreshToken) {
  const cognitoUser = new CognitoUser({ Username: email, Pool: userPool });
  const token = new CognitoRefreshToken({ RefreshToken: refreshToken });

  return new Promise((resolve, reject) => {
    cognitoUser.refreshSession(token, (err, session) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ email, ...sessionToTokens(session) });
    });
  });
}
