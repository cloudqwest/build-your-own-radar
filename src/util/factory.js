/* eslint no-constant-condition: "off" */

const d3 = require('d3')
const _ = {
  map: require('lodash/map'),
  uniqBy: require('lodash/uniqBy'),
  each: require('lodash/each'),
}

const InputSanitizer = require('./inputSanitizer')
const Radar = require('../models/radar')
const Quadrant = require('../models/quadrant')
const Ring = require('../models/ring')
const Blip = require('../models/blip')
const GraphingRadar = require('../graphing/radar')
const QueryParams = require('./queryParamProcessor')
const MalformedDataError = require('../exceptions/malformedDataError')
const SheetNotFoundError = require('../exceptions/sheetNotFoundError')
const ContentValidator = require('./contentValidator')
const Sheet = require('./sheet')
const ExceptionMessages = require('./exceptionMessages')
const GoogleAuth = require('./googleAuth')
const config = require('../config')
const featureToggles = config().featureToggles
const { getGraphSize } = require('../graphing/config')
const plotRadar = function (title, blips, currentRadarName, alternativeRadars) {
  if (title.endsWith('.csv')) {
    title = title.substring(0, title.length - 4)
  }
  if (title.endsWith('.json')) {
    title = title.substring(0, title.length - 5)
  }
  document.title = title
  d3.selectAll('.loading').remove()
  if (featureToggles.UIRefresh2022) {
    d3.select('.radar-legends').node().classList.add('show')
  }

  var rings = _.map(_.uniqBy(blips, 'ring'), 'ring')
  var ringMap = {}
  var maxRings = 4

  _.each(rings, function (ringName, i) {
    if (i === maxRings) {
      throw new MalformedDataError(ExceptionMessages.TOO_MANY_RINGS)
    }
    ringMap[ringName] = new Ring(ringName, i)
  })

  var quadrants = {}
  _.each(blips, function (blip) {
    if (!quadrants[blip.quadrant]) {
      quadrants[blip.quadrant] = new Quadrant(blip.quadrant[0].toUpperCase() + blip.quadrant.slice(1))
    }
    quadrants[blip.quadrant].add(
      new Blip(blip.name, ringMap[blip.ring], blip.isNew.toLowerCase() === 'true', blip.topic, blip.description),
    )
  })

  var radar = new Radar()
  _.each(quadrants, function (quadrant) {
    radar.addQuadrant(quadrant)
  })

  if (alternativeRadars !== undefined || true) {
    alternativeRadars.forEach(function (sheetName) {
      radar.addAlternative(sheetName)
    })
  }

  if (currentRadarName !== undefined || true) {
    radar.setCurrentSheet(currentRadarName)
  }

  const size = featureToggles.UIRefresh2022
    ? getGraphSize()
    : window.innerHeight - 133 < 620
    ? 620
    : window.innerHeight - 133
  new GraphingRadar(size, radar).init().plot()
}

const GoogleSheet = function (sheetReference, sheetName) {
  var self = {}

  self.build = function () {
    var sheet = new Sheet(sheetReference)
    sheet.validate(function (error, apiKeyEnabled) {
      if (error instanceof SheetNotFoundError) {
        plotErrorMessage(error, 'sheet')
        return
      }

      self.authenticate(false, apiKeyEnabled)
    })
  }

  function createBlipsForProtectedSheet(documentTitle, values, sheetNames) {
    if (!sheetName) {
      sheetName = sheetNames[0]
    }
    values.forEach(function () {
      var contentValidator = new ContentValidator(values[0])
      contentValidator.verifyContent()
      contentValidator.verifyHeaders()
    })

    const all = values
    const header = all.shift()
    var blips = _.map(all, (blip) => new InputSanitizer().sanitizeForProtectedSheet(blip, header))
    const title = featureToggles.UIRefresh2022 ? documentTitle : documentTitle + ' - ' + sheetName
    plotRadar(title, blips, sheetName, sheetNames)
  }

  self.authenticate = function (force = false, apiKeyEnabled, callback) {
    GoogleAuth.loadGoogle(force, async function () {
      self.error = false
      const sheet = new Sheet(sheetReference)
      await sheet.getSheet()
      if (sheet.sheetResponse.status == 403 && !GoogleAuth.gsiInitiated && !force) {
        // private sheet
        GoogleAuth.loadGSI()
      } else {
        await sheet.processSheetResponse(sheetName, createBlipsForProtectedSheet, (error) => {
          if (error.status === 403) {
            self.error = true
            plotUnauthorizedErrorMessage()
          } else {
            plotErrorMessage(error, 'sheet')
          }
        })
        if (callback) {
          callback()
        }
      }
    })
  }

  self.init = function () {
    plotLoading()
    return self
  }

  return self
}

const CSVDocument = function (url) {
  var self = {}

  self.build = function () {
    d3.csv(url)
      .then(createBlips)
      .catch((exception) => {
        plotErrorMessage(exception, 'csv')
      })
  }

  var createBlips = function (data) {
    try {
      var columnNames = data.columns
      delete data.columns
      var contentValidator = new ContentValidator(columnNames)
      contentValidator.verifyContent()
      contentValidator.verifyHeaders()
      var blips = _.map(data, new InputSanitizer().sanitize)
      plotRadar(FileName(url), blips, 'CSV File', [])
    } catch (exception) {
      plotErrorMessage(exception, 'csv')
    }
  }

  self.init = function () {
    plotLoading()
    return self
  }

  return self
}

const JSONFile = function (url) {
  var self = {}

  self.build = function () {
    d3.json(url)
      .then(createBlips)
      .catch((exception) => {
        plotErrorMessage(exception, 'json')
      })
  }

  var createBlips = function (data) {
    try {
      var columnNames = Object.keys(data[0])
      var contentValidator = new ContentValidator(columnNames)
      contentValidator.verifyContent()
      contentValidator.verifyHeaders()
      var blips = _.map(data, new InputSanitizer().sanitize)
      plotRadar(FileName(url), blips, 'JSON File', [])
    } catch (exception) {
      plotErrorMessage(exception, 'json')
    }
  }

  self.init = function () {
    plotLoading()
    return self
  }

  return self
}

const DomainName = function (url) {
  var search = /.+:\/\/([^\\/]+)/
  var match = search.exec(decodeURIComponent(url.replace(/\+/g, ' ')))
  return match == null ? null : match[1]
}

const FileName = function (url) {
  var search = /([^\\/]+)$/
  var match = search.exec(decodeURIComponent(url.replace(/\+/g, ' ')))
  if (match != null) {
    var str = match[1]
    return str
  }
  return url
}

const GoogleSheetInput = function () {
  var self = {}
  var sheet

  self.build = function () {
    const domainName = DomainName(window.location.search.substring(1))
    const queryString = featureToggles.UIRefresh2022
      ? window.location.href.match(/documentId(.*)/)
      : window.location.href.match(/sheetId(.*)/)
    const queryParams = queryString ? QueryParams(queryString[0]) : {}

    const paramId = featureToggles.UIRefresh2022 ? queryParams.documentId : queryParams.sheetId
    if (paramId && paramId.endsWith('.csv')) {
      sheet = CSVDocument(paramId)
      sheet.init().build()
    } else if (paramId && paramId.endsWith('.json')) {
      sheet = JSONFile(paramId)
      sheet.init().build()
    } else if (domainName && domainName.endsWith('google.com') && paramId) {
      sheet = GoogleSheet(paramId, queryParams.sheetName)

      sheet.init().build()
    } else {
      if (!featureToggles.UIRefresh2022) {
        document.body.style.opacity = '1'
        document.body.innerHTML = ''
        const content = d3.select('body').append('div').attr('class', 'input-sheet')
        plotLogo(content)
        const bannerText =
          '<div><h1>Build your own radar</h1><p>Once you\'ve <a href ="https://www.thoughtworks.com/radar/byor">created your Radar</a>, you can use this service' +
          ' to generate an <br />interactive version of your Technology Radar. Not sure how? <a href ="https://www.thoughtworks.com/radar/how-to-byor">Read this first.</a></p></div>'

        plotBanner(content, bannerText)

        plotForm(content)

        plotFooter(content)
      }

      setDocumentTitle()
    }
  }

  return self
}

function setDocumentTitle() {
  document.title = 'Build your own Radar'
}

function plotLoading(content) {
  if (!featureToggles.UIRefresh2022) {
    document.body.style.opacity = '1'
    document.body.innerHTML = ''
    content = d3.select('body').append('div').attr('class', 'loading').append('div').attr('class', 'input-sheet')

    setDocumentTitle()

    plotLogo(content)

    var bannerText =
      '<h1>Building your radar...</h1><p>Your Technology Radar will be available in just a few seconds</p>'
    plotBanner(content, bannerText)
    plotFooter(content)
  } else {
    document.querySelector('.helper-description > p').style.display = 'none'
    document.querySelector('.input-sheet-form').style.display = 'none'
    document.querySelector('.helper-description .loader-text').style.display = 'block'
  }
}

function plotLogo(content) {
  content
    .append('div')
    .attr('class', 'input-sheet__logo')
    .html('<a href="https://www.fourkites.com"><img src="/images/tw-logo.png" / ></a>')
}

function plotFooter(content) {
  content
    .append('div')
    .attr('id', 'footer')
    .append('div')
    .attr('class', 'footer-content')
    .append('p')
    .html(
      'Powered by <a href="https://www.fourkites.com"> FourKites</a>. ',
    )
}

function plotBanner(content, text) {
  content.append('div').attr('class', 'input-sheet__banner').html(text)
}

function plotForm(content) {
  content
    .append('div')
    .attr('class', 'input-sheet__form')
    .append('p')
    .html(
      '<strong>Enter the URL of your <a href="https://www.thoughtworks.com/radar/how-to-byor" target="_blank">Google Sheet, CSV or JSON</a> file below…</strong>',
    )

  var form = content.select('.input-sheet__form').append('form').attr('method', 'get')

  form
    .append('input')
    .attr('type', 'text')
    .attr('name', 'sheetId')
    .attr('placeholder', 'e.g. https://docs.google.com/spreadsheets/d/<sheetid> or hosted CSV/JSON file')
    .attr('required', '')

  form.append('button').attr('type', 'submit').append('a').attr('class', 'button').text('Build my radar')

  form.append('p').html("<a href='https://www.thoughtworks.com/radar/how-to-byor'>Need help?</a>")
}

function plotErrorMessage(exception, fileType) {
  if (featureToggles.UIRefresh2022) {
    showErrorMessage(exception, fileType)
  } else {
    const content = d3.select('body').append('div').attr('class', 'input-sheet')
    setDocumentTitle()

    plotLogo(content)

    const bannerText =
      '<div><h1>Build your own radar</h1><p>Once you\'ve <a href ="https://www.thoughtworks.com/radar/byor">created your Radar</a>, you can use this service' +
      ' to generate an <br />interactive version of your Technology Radar. Not sure how? <a href ="https://www.thoughtworks.com/radar/how-to-byor">Read this first.</a></p></div>'

    plotBanner(content, bannerText)

    d3.selectAll('.loading').remove()
    plotError(exception, content, fileType)

    plotFooter(content)
  }
}

function plotError(exception, container, fileType) {
  let file = 'Google Sheet'
  if (fileType === 'json') {
    file = 'Json file'
  } else if (fileType === 'csv') {
    file = 'CSV file'
  }
  let message = `Oops! We can't find the ${file} you've entered`
  let faqMessage =
    'Please check <a href="https://www.thoughtworks.com/radar/how-to-byor">FAQs</a> for possible solutions.'
  if (exception instanceof MalformedDataError) {
    message = message.concat(exception.message)
  } else if (exception instanceof SheetNotFoundError) {
    message = exception.message
  } else {
    console.error(exception)
  }
  container = container.append('div').attr('class', 'error-container')
  const errorContainer = container.append('div').attr('class', 'error-container__message')
  errorContainer.append('div').append('p').html(message)
  errorContainer.append('div').append('p').html(faqMessage)

  let homePageURL = window.location.protocol + '//' + window.location.hostname
  homePageURL += window.location.port === '' ? '' : ':' + window.location.port
  const homePage = '<a href=' + homePageURL + '>GO BACK</a>'

  errorContainer.append('div').append('p').html(homePage)
}

function showErrorMessage(exception, fileType) {
  document.querySelector('.helper-description .loader-text').style.display = 'none'
  const container = d3.select('main').append('div').attr('class', 'error-container')
  plotError(exception, container, fileType)
}

function plotUnauthorizedErrorMessage() {
  let content
  const helperDescription = d3.select('.helper-description')
  if (!featureToggles.UIRefresh2022) {
    content = d3.select('body').append('div').attr('class', 'input-sheet')
    setDocumentTitle()

    plotLogo(content)

    const bannerText = '<div><h1>Build your own radar</h1></div>'

    plotBanner(content, bannerText)

    d3.selectAll('.loading').remove()
  } else {
    content = d3.select('main')
    helperDescription.style('display', 'none')
    d3.selectAll('.loader-text').remove()
    d3.selectAll('.error-container').remove()
  }
  const currentUser = GoogleAuth.getEmail()
  let homePageURL = window.location.protocol + '//' + window.location.hostname
  homePageURL += window.location.port === '' ? '' : ':' + window.location.port
  const goBack = '<a href=' + homePageURL + '>GO BACK</a>'
  const message = `<strong>Oops!</strong> Looks like you are accessing this sheet using <b>${currentUser}</b>, which does not have permission.Try switching to another account.`

  const container = content.append('div').attr('class', 'error-container')

  const errorContainer = container.append('div').attr('class', 'error-container__message')

  errorContainer.append('div').append('p').attr('class', 'error-title').html(message)

  const button = errorContainer.append('button').attr('class', 'button switch-account-button').text('SWITCH ACCOUNT')

  errorContainer
    .append('div')
    .append('p')
    .attr('class', 'error-subtitle')
    .html(`or ${goBack} to try a different sheet.`)

  button.on('click', () => {
    let sheet
    if (featureToggles.UIRefresh2022) {
      const queryString = window.location.href.match(/documentId(.*)/)
      const queryParams = queryString ? QueryParams(queryString[0]) : {}
      sheet = GoogleSheet(queryParams.documentId, queryParams.sheetName)
    } else {
      const queryString = window.location.href.match(/sheetId(.*)/)
      const queryParams = queryString ? QueryParams(queryString[0]) : {}
      sheet = GoogleSheet(queryParams.sheetId, queryParams.sheetName)
    }
    sheet.authenticate(true, false, () => {
      if (featureToggles.UIRefresh2022 && !sheet.error) {
        helperDescription.style('display', 'block')
        errorContainer.remove()
      } else if (featureToggles.UIRefresh2022 && sheet.error) {
        helperDescription.style('display', 'none')
      } else {
        content.remove()
      }
    })
  })
}

module.exports = GoogleSheetInput
