import { remove, assign } from 'lodash'

const DEFAULT_LIMIT = 10

const ensurePositiveIntWithDefault = (val, def) => {
  if (!val) return def
  const _val = parseInt(val, 10)
  if (Number.isNaN(_val)) {
    return def
  }
  return _val
}


const count = (self, Model, tableName, idAttribute, limit) => {
  const notNeededQueries = [
    'orderByBasic',
    'orderByRaw',
    'groupByBasic',
    'groupByRaw',
  ]
  const counter = Model.forge()

  return counter.query(qb => {
    assign(qb, self.query().clone())

    // Remove grouping and ordering. Ordering is unnecessary
    // for a count, and grouping returns the entire result set
    // What we want instead is to use `DISTINCT`
    remove(qb._statements, statement => (
      (notNeededQueries.indexOf(statement.type) > -1) ||
        statement.grouping === 'columns'
    ))
    qb.countDistinct.apply(qb, [`${tableName}.${idAttribute}`])
  }).fetchAll().then(result => {
    const metadata = { limit }

    if (result && result.length === 1) {
      // We shouldn't have to do this, instead it should be
      // result.models[0].get('count')
      // but SQLite uses a really strange key name.
      const modelsCount = result.models[0]
      const keys = Object.keys(modelsCount.attributes)
      if (keys.length === 1) {
        const key = Object.keys(modelsCount.attributes)[0]
        metadata.rowCount = parseInt(modelsCount.attributes[key], 10)
      }
    }

    return metadata
  })
}

const reverseSign = (sign) => ({ '>': '<', '<': '>' }[sign])

const applyCursor = (qb, cursor, mainTableName, idAttribute) => {
  const isNotSorted = qb._statements
    .filter(s => s.type === 'orderByBasic')
    .length === 0

  // We implicitly sort by ID asc
  if (isNotSorted) {
    qb.orderBy(`${mainTableName}.${idAttribute}`)
  }

  const sortedColumns = qb._statements
    .filter(s => s.type === 'orderByBasic')
    .map(({ value, ...other }) => {
      const [tableName, colName] = value.split('.')
      if (typeof colName === 'undefined') {
        // not prefixed by table name
        return { name: tableName, ...other }
      }
      if (tableName !== mainTableName) {
        throw new Error('sorting by joined table not supported by cursor paging yet')
      }
      return { name: colName, ...other }
    })

  const buildWhere = ([currentCol, ...remainingCols], visitedCols = []) => {
    const { name, direction } = currentCol
    const index = visitedCols.length
    const cursorValue = cursor.columnValues[index]
    const cursorType = cursor.type
    let sign = '>'
    if (cursorType === 'before') {
      sign = reverseSign(sign)
    }
    if (direction === 'DESC') {
      sign = reverseSign(sign)
    }
    /* eslint-disable func-names */
    qb.orWhere(function () {
      visitedCols.forEach((visitedCol, idx) => {
        this.andWhere(visitedCol.name, '=', cursor.columnValues[idx])
      })
      this.andWhere(name, sign, cursorValue)
    })
    if (!remainingCols.length) return
    return buildWhere(remainingCols, [...visitedCols, currentCol])
  }

  if (cursor) {
    if (sortedColumns.length !== cursor.columnValues.length) {
      throw new Error('sort/cursor mismatch')
    }
    buildWhere(sortedColumns)
  }

  // This will only work if column name === attribute name
  const model2cursor = (model) => sortedColumns.map(({ name }) => model.get(name))

  const extractCursors = (coll) => {
    if (!coll.length) return {}
    const before = model2cursor(coll.models[0])
    const after = model2cursor(coll.models[coll.length - 1])
    return { after, before }
  }
  return extractCursors
}

const ensureArray = (val) => {
  if (!Array.isArray(val)) {
    throw new Error(`${val} is not an array`)
  }
}

/**
 * Exports a plugin to pass into the bookshelf instance, i.e.:
 *
 *      import config from './knexfile'
 *      import knex from 'knex'
 *      import bookshelf from 'bookshelf'
 *
 *      const ORM = bookshelf(knex(config))
 *
 *      ORM.plugin('bookshelf-cursor-pagination')
 *
 *      export default ORM
 *
 * The plugin attaches an instance methods to the bookshelf
 * Model object: fetchCursorPage.
 *
 * Model#fetchCursorPage works like Model#fetchAll, but returns a single page of
 * results instead of all results, as well as the pagination information
 *
 * See methods below for details.
 */
export default (bookshelf) => {
  /**
   * @method Model#fetchCursorPage
   * @belongsTo Model
   *
   * Similar to {@link Model#fetchAll}, but fetches a single page of results
   * as specified by the limit (page size) and cursor (before or after).
   *
   * Any options that may be passed to {@link Model#fetchAll} may also be passed
   * in the options to this method.
   *
   * To perform pagination, you may include *either* an `after` or `before`
   * cursor.
   *
   * By default, with no parameters or missing parameters, `fetchCursorPage` will use an
   * options object of `{limit: 1}`
   *
   * Below is an example showing the user of a JOIN query with sort/ordering,
   * pagination, and related models.
   *
   * @example
   *
   * Car
   * .query(function (qb) {
   *    qb.innerJoin('manufacturers', 'cars.manufacturer_id', 'manufacturers.id')
   *    qb.groupBy('cars.id')
   *    qb.where('manufacturers.country', '=', 'Sweden')
   * })
   * .orderBy('-productionYear') // Same as .orderBy('cars.productionYear', 'DESC')
   * .fetchCursorPage({
   *    limit: 15, // Defaults to 10 if not specified
   *    after: 3,
   *
   *    withRelated: ['engine'] // Passed to Model#fetchAll
   * })
   * .then(function (results) {
   *    console.log(results) // Paginated results object with metadata example below
   * })
   *
   * // Pagination results:
   *
   * {
   *    models: [<Car>], // Regular bookshelf Collection
   *    // other standard Collection attributes
   *    ...
   *    pagination: {
   *        rowCount: 53, // Total number of rows found for the query before pagination
   *        limit: 15, // The requested number of rows per page
   *    }
   * }
   *
   * @param options {object}
   *    The pagination options, plus any additional options that will be passed to
   *    {@link Model#fetchAll}
   * @returns {Promise<Model|null>}
   */
  const fetchCursorPage = ({
    self,
    collection,
    Model,
  }, options = {}) => {
    const { limit, ...fetchOptions } = options

    const cursor = (() => {
      if ('after' in options) {
        ensureArray(options.after)
        return { type: 'after', columnValues: options.after }
      } else if ('before' in options) {
        ensureArray(options.before)
        return { type: 'before', columnValues: options.before }
      }
      return null
    })()

    const _limit = ensurePositiveIntWithDefault(limit, DEFAULT_LIMIT)

    const tableName = Model.prototype.tableName
    const idAttribute = Model.prototype.idAttribute ?
      Model.prototype.idAttribute : 'id'

    const paginate = () => {
      // const pageQuery = clone(model.query())
      const pager = collection

      let extractCursors
      return pager
        .query(qb => {
          assign(qb, self.query().clone())
          extractCursors = applyCursor(qb, cursor, tableName, idAttribute)
          qb.limit(_limit)
        })
        .fetch(fetchOptions)
        .then(coll => {
          const cursors = extractCursors(coll)
          return { coll, cursors }
        })
    }

    return Promise.all([
      paginate(),
      count(self, Model, tableName, idAttribute, _limit),
    ])
    .then(([{ coll, cursors }, metadata]) => {
      const pageCount = Math.ceil(metadata.rowCount / _limit)
      const pageData = assign(metadata, { pageCount })
      return assign(coll, {
        pagination: {
          ...pageData,
          cursors,
        },
      })
    })
  }

  bookshelf.Model.prototype.fetchCursorPage = function modelFetchCursorPage(...args) {
    return fetchCursorPage({
      self: this,
      Model: this.constructor,
      collection: () => this.collection(),
    }, ...args)
  }

  bookshelf.Model.fetchCursorPage = function staticModelFetchCursorPage(...args) {
    return this.forge().fetchCursorPage(...args)
  }

  bookshelf.Collection.prototype.fetchCursorPage = function collectionFetchCursorPage(...args) {
    return fetchCursorPage({
      self: this,
      Model: this.model,
      collection: this,
    }, ...args)
  }
}
