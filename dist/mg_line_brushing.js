(function(root, factory) {
  if (typeof define === 'function' && define.amd) {
    define(['d3', 'metrics-graphics/dist/metricsgraphics'], factory);
  } else if (typeof exports === 'object') {
    module.exports = factory(require('d3'), require('metrics-graphics/dist/metricsgraphics'));
  } else {
    root.Mg_line_brushing = factory(root.d3, root.MG);
  }
}(this, function(d3, MG) {
/**
  2. accessors
*/

MG.line_brushing = {
  set_brush_as_base: function(target) {
    var svg = d3.select(target).select('svg'),
        current,
        history = brushHistory[target];

    svg.classed('mg-brushed', false);

    if (history) {
      history.brushed = false;

      current = history.current;
      history.original = current;

      args.min_x = current.min_x;
      args.max_x = current.max_x;
      args.min_y = current.min_y;
      args.max_y = current.max_y;

      history.steps = [];
    }
  },

  zoom_in: function(target, options) {

  },

  zoom_out: function(target, options) {

  }
};

/* helpers */
function get_brush_interval(args) {
    var resolution = args.brushing_interval,
        interval;

    if (!resolution) {
        if (args.time_series) {
            resolution = d3.time.day;
        } else {
            resolution = 1;
        }
    }

    // work with N as integer
    if (typeof resolution === 'number') {
        interval = {
            round: function(val) {
                return resolution * Math.round(val / resolution);
            },
            offset: function(val, count) {
                return val + (resolution * count);
            }
        };
    }
    // work with d3.time.[interval]
    else if (typeof resolution.round === 'function'
             && typeof resolution.offset === 'function' ) {
        interval = resolution;
    }
    else {
        console.warn('The `brushing_interval` provided is invalid. It must be either a number or expose both `round` and `offset` methods');
    }

    return interval;
}

function is_within_bounds(datum, args) {
    var x = +datum[args.x_accessor],
        y = +datum[args.y_accessor];

    return x >= (+args.processed.min_x || x)
        && x <= (+args.processed.max_x || x)
        && y >= (+args.processed.min_y || y)
        && y <= (+args.processed.max_y || y);
}


/**
  Brushing for line charts

  1. hooks
*/

var brushHistory = {},
  args;

MG.add_hook('global.defaults', function(args) {
  // enable brushing unless it's explicitly disabled
  args.brushing = args.brushing !== false;
  if (args.brushing) {    
    args.aggregate_rollover = true;
  }
});

function brushing() {
    var chartContext = this;

    args = this.args;

    if (args.brushing === false) {
        return this;
    }

    if (!brushHistory[args.target] || !brushHistory[args.target].brushed) {
        brushHistory[args.target] = {
            brushed: false,
            steps: [],
            original: {
                min_x: +args.processed.min_x,
                max_x: +args.processed.max_x,
                min_y: +args.processed.min_y,
                max_y: +args.processed.max_y
            }
        };
    }

    var isDragging = false,
        isScrolling= false,
        mouseDown = false,
        originX,
        svg = d3.select(args.target).select('svg'),
        body = d3.select('body'),
        rollover = svg.select('.mg-rollover-rect, .mg-voronoi'),
        brushingGroup,
        extentRect;

    rollover.classed('mg-brush-container', true);

    brushingGroup = rollover.insert('g', '*')
        .classed('mg-brush', true);

    extentRect = brushingGroup.append('rect')
        .attr('opacity', 0)
        .attr('y', args.top)
        .attr('height', args.height - args.bottom - args.top - args.buffer)
        .classed('mg-extent', true);

    
    if(!window['mgScrollInterval']) {
        var curr = window.scrollY;
        window['mgScrollInterval'] = setInterval(function interval() {
            if(window.scrollY !== curr) {
                isScrolling = true;
                clearInterval(window['mgScrollInterval']);
                setTimeout(function() {
                    curr = window.scrollY;
                    window['mgScrollInterval'] = setInterval(interval, 10);
                }, 5000);                            
            }
            else if(isScrolling)
                isScrolling = false;            
        }, 10)
    }

    // mousedown, start area selection
    svg.on('mousedown', onClickDown);
    svg.on('touchstart', onClickDown);

    function onClickDown () {
        var mouseX = d3.mouse(this)[0];
        setTimeout(function() {
            if(!isScrolling) {
                mouseDown = true;
                isDragging = false;
                originX = mouseX;
                svg.classed('mg-brushed', false);
                svg.classed('mg-brushing-in-progress', true);
                extentRect.attr({
                    x: mouseX,
                    opacity: 0,
                    width: 0
                });
            }
        }, 100);
    }

    // mousemove / drag, expand area selection
    svg.on('mousemove', onMove);
    svg.on('touchmove', onMove);

    function onMove() {
        if(originX) {
            var mouseX = d3.mouse(this)[0],
                newX = Math.min(originX, mouseX),
                width = Math.max(originX, mouseX) - newX;

            setTimeout(function() {
                if (!isScrolling && mouseDown) {
                    isDragging = true;
                    rollover.classed('mg-brushing', true);                

                    extentRect
                    .attr('x', newX)
                    .attr('width', width)
                    .attr('opacity', 1);
                }
            }, 100);
        }
    }

    // mouseup, finish area selection
    svg.on('mouseup', onClickUp);
    svg.on('touchend', onClickUp);

    function onClickUp() {        
        if(isScrolling || onClickUp['debounce']){
            if(extentRect){
                extentRect.remove();
                mouseDown = false;
                svg.classed('mg-brushing-in-progress', false);
            }
                
            return;
        }

        mouseDown = false;
        svg.classed('mg-brushing-in-progress', false);

        var xScale = args.scales.X,
            yScale = args.scales.Y,
            flatData = [].concat.apply([], args.data),
            boundedData,
            yBounds,
            xBounds,
            extentX0 = +extentRect.attr('x'),
            extentX1 = extentX0 + (+extentRect.attr('width')),
            interval = get_brush_interval(args),
            offset = 0,
            mapDtoX = function(d) { return +d[args.x_accessor]; },
            mapDtoY = function(d) { return +d[args.y_accessor]; };

        // if we're zooming in: calculate the domain for x and y axes based on the selected rect
        if (isDragging) {
            isDragging = false;

            if (brushHistory[args.target].brushed) {
                brushHistory[args.target].steps.push({
                    max_x: args.brushed_max_x || args.processed.max_x,
                    min_x: args.brushed_min_x || args.processed.min_x,
                    max_y: args.brushed_max_y || args.processed.max_y,
                    min_y: args.brushed_min_y || args.processed.min_y
                });
            }

            brushHistory[args.target].brushed = true;

            boundedData = [];
            // is there at least one data point in the chosen selection? if not, increase the range until there is.
            var iterations = 0;
            while (boundedData.length === 0 && iterations <= flatData.length) {

                var xValX0 = xScale.invert(extentX0);
                var xValX1 = xScale.invert(extentX1);
                xValX0 = xValX0 instanceof Date ? xValX0 : interval.round(xValX0);
                xValX1 = xValX1 instanceof Date ? xValX1 : interval.round(xValX1);

                args.brushed_min_x = xValX0;
                args.brushed_max_x = Math.max(interval.offset(args.min_x, 1), xValX1);

                boundedData = flatData.filter(function(d) {
                    var val = d[args.x_accessor];
                    return val >= args.brushed_min_x && val <= args.brushed_max_x;
                });

                iterations++;
            }

            xBounds = d3.extent(boundedData, mapDtoX);
            args.brushed_min_x = +xBounds[0];
            args.brushed_max_x = +xBounds[1];
            xScale.domain(xBounds);

            yBounds = d3.extent(boundedData, mapDtoY);
            // add 10% padding on the y axis for better display
            // @TODO: make this an option
            args.brushed_min_y = yBounds[0] * 0.9;
            args.brushed_max_y = yBounds[1] * 1.1;
            yScale.domain(yBounds);
        }
        // zooming out on click, maintaining the step history
        else {
            if (brushHistory[args.target].brushed) {
                var previousBrush = brushHistory[args.target].steps.pop();
                if (previousBrush) {
                    args.brushed_max_x = previousBrush.max_x;
                    args.brushed_min_x = previousBrush.min_x;
                    args.brushed_max_y = previousBrush.max_y;
                    args.brushed_min_y = previousBrush.min_y;

                    xBounds = [args.brushed_min_x, args.brushed_max_x];
                    yBounds = [args.brushed_min_y, args.brushed_max_y];
                    xScale.domain(xBounds);
                    yScale.domain(yBounds);
                } else {
                    brushHistory[args.target].brushed = false;

                    delete args.brushed_max_x;
                    delete args.brushed_min_x;
                    delete args.brushed_max_y;
                    delete args.brushed_min_y;

                    xBounds = [
                        brushHistory[args.target].original.min_x,
                        brushHistory[args.target].original.max_x
                    ];

                    yBounds = [
                        brushHistory[args.target].original.min_y,
                        brushHistory[args.target].original.max_y
                    ];
                }
            }
        }

        // has anything changed?
        if (xBounds && yBounds) {
            if (xBounds[0] < xBounds[1]) {
                // trigger the brushing callback

                var step = {
                    min_x: xBounds[0],
                    max_x: xBounds[1],
                    min_y: yBounds[0],
                    max_y: yBounds[1]
                };

                brushHistory[args.target].current = step;

                if (args.after_brushing) {
                    args.after_brushing.apply(this, [step]);
                }
            }

            // redraw the chart
            if (!args.brushing_manual_redraw) {
            MG.data_graphic(args);
            }
        }      

        onClickUp['debounce'] = setTimeout(function() {
            onClickUp['debounce'] = undefined;
        }, 100);
    }

    return this;
}

MG.add_hook('line.after_init', function(lineChart) {
  brushing.apply(lineChart);
});

function processXAxis(args, min_x, max_x) {
  if (args.brushing) { 
    args.processed.min_x = args.brushed_min_x ? Math.max(args.brushed_min_x, min_x) : min_x;
    args.processed.max_x = args.brushed_max_x ? Math.min(args.brushed_max_x, max_x) : max_x;
  }
}

MG.add_hook('x_axis.process_min_max', processXAxis);

function processYAxis(args) {
  if (args.brushing && (args.brushed_min_y || args.brushed_max_y)) {
    args.processed.min_y = args.brushed_min_y;
    args.processed.max_y = args.brushed_max_y;
  }
}

MG.add_hook('y_axis.process_min_max', processYAxis);

function afterRollover(args) {
  if (brushHistory[args.target] && brushHistory[args.target].brushed) {
    var svg = d3.select(args.target).select('svg');
    svg.classed('mg-brushed', true);
  }
}

MG.add_hook('line.after_rollover', afterRollover);

return ;
}));
