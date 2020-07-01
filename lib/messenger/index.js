const r2 = require('r2')

const BASE_URL = process.env.FACEBOOK_GRAPH_URL || "https://graph.facebook.com/v3.2"
const RETRIES = process.env.FACEBOOK_RETRIES || 5

async function facebookRequest(reqFn, retries = 0) {
  let res;

  try {
    res = await reqFn()
  } catch (e) {

    // RETRY ETIMEDOUT ERRORS
    if (e.code === 'ETIMEDOUT' && retries < RETRIES) {
      return facebookRequest(reqFn, retries+1)
    }
    else {
      throw e
    }
  }

  if (res && res.error) {

    // TODO: maybe 551 should be removed as it probably won't work on retry?
    const retryCodes = [1200, 551]
    if (retryCodes.includes(res.error.code) && retries < RETRIES) {
      return facebookRequest(reqFn, retries+1)
    } else {
      throw new Error(JSON.stringify(res.error))
    }
  }

  return res
}

async function getUserInfo(id, pageToken) {
  const url = `${BASE_URL}/${id}?fields=id,name,first_name,last_name`
  const headers = { Authorization: `Bearer ${pageToken}`}
  try {
    const res = await facebookRequest(() => r2.get(url, {headers}).json)
    return res
  }
  catch (e) {
    console.warn(`Error fetching user information for user: ${id}\n with Error code: ${e.code}\n and error: ${e}`)
    return { id }
  }
}


async function sendMessage(data, pageToken) {
  const headers = { Authorization: `Bearer ${pageToken}`}
  const url = `${BASE_URL}/me/messages`
  const fn = () => r2.post(url, { headers, json:data }).json
  const res = await facebookRequest(fn)
  return res
}

module.exports = {sendMessage, getUserInfo}
