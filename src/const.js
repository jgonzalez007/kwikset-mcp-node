// Kwikset publishes no official API, so these values are not "secrets" in
// the normal sense - they're the same AWS Cognito app-client configuration
// and REST host the Kwikset mobile app itself uses, extracted (openly, the
// same way any interoperability project does) from the published source of
// homebridge-kwikset-halo (github.com/TreehouseFalcon/homebridge-kwikset-halo,
// Apache-2.0), a community Homebridge plugin for the same locks. That
// project's author in turn credits `aiokwikset` (the Python library) for
// documenting these endpoints first.
//
// Because none of this is officially supported, Kwikset could change any of
// it without notice. If login or API calls start failing outright (not just
// a single tool erroring), this file is the first place to check against
// the upstream plugin for updated values.

export const COGNITO_USER_POOL_ID = "us-east-1_6B3uo6uKN";
export const COGNITO_USER_POOL_CLIENT_ID = "5eu1cdkjp1itd1fi7b91m6g79s";
export const COGNITO_REGION = "us-east-1";
export const API_HOST = "ynk95r1v52.execute-api.us-east-1.amazonaws.com";
export const API_USER_AGENT = "KwiksetMCP/0.1.0";
