const util = require('util')
const r2 = require('r2')
const {recursiveJSONParser, getForm, getMetadata, parseLogJSON, splitLogsByForm} = require('./utils')
const {translator, validator}= require('../translate-typeform')
const {translateField, getField, getNextField } = require('./form')

function repeatResponse(question, text) {
  if (!text) {
    throw new TypeError(`Repeat response attempted without valid text: ${text}\nquestion: ${question}` )
  }

  return {
    text,
    metadata: JSON.stringify({ repeat: true, ref: question })
  }
}

function getWatermark(event) {
  if (!event.read && !event.delivery) return undefined

  const type = event.read ? 'read' : 'delivery'
  const mark = event[type].watermark

  return {type, mark}
}

function _currentForm(state) {
  if (!state.forms) return
  return state.forms[state.forms.length - 1]
}

function categorizeEvent(nxt) {
  if (nxt.referral ||
      (nxt.postback && nxt.postback.referral) ||
      (nxt.postback && nxt.postback.payload === 'get_started')) {
    return 'REFERRAL'
  }

  if (getWatermark(nxt)) return 'WATERMARK'
  if (nxt.message && nxt.message.is_echo) return 'ECHO'
  if (nxt.postback) return 'POSTBACK'
  if (nxt.message && nxt.message.quick_reply) return 'QUICK_REPLY'
  if (nxt.message && nxt.message.text !== undefined) return 'TEXT'
  if (nxt.message && nxt.message.attachments) return 'MEDIA'

  throw new TypeError(`Machine could not categorize event!
		       \nEvent: ${util.inspect(nxt, null, 8)}`)
}

function _noop() {
  return { action: 'NONE' }
}

function exec (state, nxt) {

  switch(categorizeEvent(nxt)) {

  case 'REFERRAL':
    const form = getForm(nxt)

    if (form === _currentForm(state)) return _noop()

    return { action: 'SWITCH_FORM',
             form,
             md: getMetadata(nxt)}


  case 'WATERMARK':
    const {type, mark} = getWatermark(nxt)

    // ignore if mark already higher
    if (state[type] >= mark) return _noop()
    return { action: 'WATERMARK', update: {[type]: mark} }


  case 'ECHO':
    const md = nxt.message.metadata

    // If it hasn't been sent by the bot, ignore it
    // If it's a repeat or a statement, ignore it
    if (!md || md.repeat ||
        md.type === 'statement') {
      return _noop()
    }

    if (md.type === 'thankyou_screen') {
      return { action: 'END', question: nxt.message.metadata.ref }
    }

    // if we receive the echo, we now assume that
    // the user has the question.
    // TODO: simulate problems. Can use timestamps?
    return { action: 'WAIT_RESPONSE',
             question: md.ref }


  case 'POSTBACK':
    if (state.state === 'RESPONDING') return _noop()
    return { action: 'RESPOND',
             response: nxt.postback.payload.value,
             question: state.question }

  case 'QUICK_REPLY':
    if (state.state === 'RESPONDING') return _noop()
    return { action: 'RESPOND',
             response: nxt.message.quick_reply.payload.value,
             question: state.question }

  case 'TEXT':
    if (state.state === 'RESPONDING') return _noop()

    // Handles the odd case (testers) where they begin
    // texting without any other previous state
    if (state.state === 'START') {
      return { action: 'SWITCH_FORM', form: getForm(nxt) }
    }

    return { action: 'RESPOND',
             response: nxt.message.text,
             question: state.question }

  case 'MEDIA':
    if (state.state === 'RESPONDING') return _noop()

    // Handles the odd case (testers) where they begin
    // texting without any other previous state
    if (state.state === 'START') {
      return { action: 'SWITCH_FORM', form: getForm(nxt) }
    }
    return { action: 'RESPOND',
             response: '[STICKER]',
             question: state.question }

  default:
    throw new TypeError(`Machine did not produce output!\nState: ${util.inspect(state, null, 8)}\nEvent: ${util.inspect(nxt, null, 8)}`)

  }
}


function apply (state, output) {
  switch(output.action) {

  case 'WATERMARK':
    return {...state, ...output.update }

  case 'RESPOND':
    const qa = updateQA(state.qa, update(output))
    return {...state, state: 'RESPONDING',
            question: output.question,
            qa }

  case 'SWITCH_FORM':
    return { ..._initialState(),
             state: 'RESPONDING',
             forms: [...state.forms, output.form],
             md: output.md }

  case 'WAIT_RESPONSE':
    return {...state, state: 'QOUT',
            question: output.question }

  case 'END':
    return {...state, state: 'END', question: output.question }

  default:
    return state
  }
}

function act (ctx, state, output) {
  switch(output.action) {

  case 'RESPOND':
    const qa = apply(state, output).qa
    return respond({...ctx, md: state.md}, qa, output)

  case 'SWITCH_FORM':
    return respond({...ctx, md: output.md}, [], output)

  default:
    return []
  }
}

function updateQA(qa, u) {
  return u ? [...qa, u] : qa
}

function update ({action, question, response}) {
  if (action === 'RESPOND' && question && response) {
    return [question, response]
  }
}

function nextQuestion(ctx, qa, question) {
  const field = getNextField(ctx, qa, question)
  return field ? translateField(ctx, qa, field) : null
}

function _gatherResponses(ctx, qa, q, previous = []) {
  const md = q && JSON.parse(q.metadata)

  if (md.repeat) {
    const repeat = translateField(ctx, qa, getField(ctx, md.ref))
    return [q, repeat]
  }

  if (md.type === 'statement') {
    // if question is statement, recursively
    // get the next question and send it too!
    const nq = nextQuestion(ctx, qa, JSON.parse(q.metadata).ref)
    if (nq) return _gatherResponses(ctx, qa, nq, [...previous, q])
  }

  return [...previous, q]
}

function _response (ctx, qa, {question, validation, response}) {

  // if we haven't asked anything, it must be the first question!
  if (!question) {
    return translateField(ctx, qa, ctx.form.fields[0])
  }

  // otherwise, validate the response
  const {valid, message} = validation ||
        validator(getField(ctx, question), ctx.form.custom_messages)(response)

  if (!valid) {
    // Note: this could be abstracted to be more flexible
    return repeatResponse(question, message)
  }

  return nextQuestion(ctx, qa, question)
}

function respond (ctx, qa, output) {
  return _gatherResponses(ctx, qa, _response(ctx, qa, output)).filter(r => !!r)
}

function _initialState() {
  return { state: 'START', qa: [], forms: [] }
}

function getState(log) {
  if (!log || !log.length) {
    return _initialState()
  }
  return log.reduce((s,e) => apply(s, exec(s,e)), _initialState())
}

function getMessage(log, form, user) {
  const event = log.slice(-1)[0]
  const state = getState(log.slice(0,-1))
  return act({form, user}, state, exec(state, event))
}


module.exports = {
  getWatermark,
  getState,
  exec,
  apply,
  act,
  update,
  getMessage,
  _initialState
}
