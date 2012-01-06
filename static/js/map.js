/*global $, google, InfoBox */
var simulation_manager = (function(){
    var config = (function(){
        var params = {
            center_start: new google.maps.LatLng(47.378, 8.540),
            zoom_start: 13,
            zoom_follow: 17,
            zoom_station: 15,
            zoom_mouseover_min: 7,
            ft_id_mask: '812706',
            ft_id_lines: '1497331',
            ft_id_stations: '1497361',
            edges_path: 'static/js/edges_encoded-sbb.js'
        };
        
        return {
            getParam: function(p) {
                return params[p];
            }
        }
    })();
    
    var map = null;
    
    var listener_helpers = (function(){
        var listeners = {
            map_init: []
        };
        
        function notify(type) {
            $.each(listeners[type], function(i, fn){
                fn();
            });
        }

        function subscribe(type, fn) {
            listeners[type].push(fn);
        }
        
        return {
            notify: notify,
            subscribe: subscribe
        }
    })();
    
    var stationsPool = (function(){
        var stations = {};
        
        function get(id) {
            return (typeof stations[id]) === 'undefined' ? '' : stations[id].get('name');
        }
        
        function location_get(id) {
            return (typeof stations[id]) === 'undefined' ? '' : stations[id].get('location');
        }
        
        function add(id, name, x, y) {
            var station = new google.maps.MVCObject();
            station.set('name', name);
            station.set('location', new google.maps.LatLng(parseFloat(y), parseFloat(x)));
            
            stations[id] = station;
        }
        
        return {
            get: get,
            add: add,
            location_get: location_get
        };
    })();

    // Routes manager.
    // Roles:
    // - keep a reference for the routes between stations
    //      i.e. (Zürich HB-Bern, Zürich HB-Olten, Olten-Bern)
    //      Note: one route can contain one or more edges (the low-level entity in the simulation graph)
    // - interpolate position at given percent along a route
    var linesPool = (function() {
        var network_lines = {};
        var routes = {};
        var route_highlight = new google.maps.Polyline({
            path: [],
            strokeColor: "#FDD017",
            strokeOpacity: 0.8,
            strokeWeight: 5,
            map: null,
            ids: null
        });
        
        // TODO - that can be a nice feature request for google.maps.geometry lib
        function positionOnRouteAtPercentGet(a, b, perc) {
            var route = routes[a + '_' + b];
            
            var dC = 0;
            var dAC = route.length*perc;
            
            for (var i=1; i<route.points.length; i++) {
                var pA = route.points[i-1];
                var pB = route.points[i];
                var d12 = google.maps.geometry.spherical.computeDistanceBetween(pA, pB);
                if ((dC + d12) > dAC) {
                    return google.maps.geometry.spherical.interpolate(pA, pB, (dAC - dC)/d12);
                }
                dC += d12;
            }
            
            return null;
        }
        
        function routeExists(a, b) {
          return typeof routes[a + '_' + b] !== 'undefined';
        }
        
        function routeAdd(a, b, edges) {
            var routePoints = [];
            $.each(edges, function(k, edgeID) {
                var points = network_lines[Math.abs(edgeID)];
                if (edgeID < 0) {
                    // slice() to the resue, otherwise reverse will alter network_lines
                    points = points.slice().reverse();
                }
                // TODO - use some MVCArray magic to remove the last element of edges when concatenating ?
                routePoints = routePoints.concat(points);
            });
            
            var routeLength = google.maps.geometry.spherical.computeLength(routePoints).toFixed(3);
            
            routes[a + '_' + b] = {
                'points': routePoints,
                'length': routeLength
            };
        }
        
        function lengthGet(a, b) {
            return routes[a + '_' + b].length;
        }
        
        function routeHighlight(station_ids) {
            if (route_highlight.get('ids') === station_ids.join(',')) { return; }
            route_highlight.set('ids', station_ids.join(','));
            
            var points = [];
            $.each(station_ids, function(index, id){
                if (index === 0) { return; }
                points = points.concat(routes[station_ids[index-1] + '_' + id].points);
            });
            
            route_highlight.setPath(points);
            route_highlight.setMap(map);
        }
        
        function routeHighlightRemove() {
            route_highlight.setMap(null);
            route_highlight.set('ids', null);
        }
        
        function loadEncodedEdges(edges) {
            $.each(edges, function(index, encoded_edge) {
                network_lines[index] = google.maps.geometry.encoding.decodePath(encoded_edge);
            });
        }
        
        return {
            positionGet: positionOnRouteAtPercentGet,
            routeExists: routeExists,
            routeAdd: routeAdd,
            lengthGet: lengthGet,
            routeHighlight: routeHighlight,
            routeHighlightRemove: routeHighlightRemove,
            loadEncodedEdges: loadEncodedEdges
        };
    })();
    
    // Time helpers
    // Roles:
    // - convert seconds that passed from midnight into nicely formatted hh:mm:ss
    // and viceversa
    var time_helpers = (function(){
        function hms2s(hms) {
            var parts = hms.split(':');
            return parseInt(parts[0], 10)*3600 + parseInt(parts[1], 10)*60 + parseInt(parts[2], 10);
        }
        function s2hms(dayS) {
            function pad2Dec(what) {
                return (what < 10 ? '0' + what : what);
            }
            
            if (dayS >= 3600*24) {
                dayS -= 3600*24;
            }
            
            // From http://stackoverflow.com/questions/1322732/convert-seconds-to-hh-mm-ss-with-javascript
            var hours = Math.floor(dayS / 3600);
            dayS %= 3600;
            var minutes = Math.floor(dayS / 60);
            var seconds = dayS % 60;
            
            return pad2Dec(hours) + ':' + pad2Dec(minutes) + ':' + pad2Dec(seconds);
        }
        function s2hm(dayS) {
            // TODO - Round seconds to minutes, can be done nicer ?
            dayS = (dayS/60).toFixed(0)*60;
            var hms = s2hms(dayS);
            return hms.substr(0, 5);
        }
        
        return {
            hms2s: hms2s,
            s2hms: s2hms,
            s2hm: s2hm
        };
    })();

    // Time manager
    // Roles:
    // - manages the current number of seconds that passed since midnight
    // - 'init' can be used with given hh:mm:ss in order to simulate different timestamps
    var timer = (function(){
        var delay = 0;
        
        function getNow() {
            var now = new Date();

            var hours = now.getHours();
            var minutes = now.getMinutes();
            var seconds = now.getSeconds();
            
            return hours*3600 + minutes*60 + seconds;
        }
        
        function getDaySeconds() {
            return getNow() - delay;
        }
        
        function init(hms) {
            if (typeof(hms) !== 'undefined') {
                delay = getNow() - time_helpers.hms2s(hms);
            }
            
            var timeContainer = $('#day_time');
            function paintHM() {
                timeContainer.text(time_helpers.s2hms(getDaySeconds()));
            }
            
            setInterval(function(){
                paintHM();
            }, 1000);
        }
        
        function getHM() {
          var hms = time_helpers.s2hms(getDaySeconds());
          return hms.substring(0, 2) + hms.substring(3, 5);
        }
        
        return {
            init: init,
            getTime: getDaySeconds,
            getHM: getHM
        };
    })();
    
    function map_init(){
        var mapStyles = [
          {
            featureType: "poi.business",
            stylers: [
              { visibility: "off" }
            ]
          },{
            featureType: "road",
            elementType: "labels",
            stylers: [
              { visibility: "off" }
            ]
          },{
            featureType: "road",
            elementType: "labels",
            stylers: [
              { visibility: "off" }
            ]
          },{
            featureType: "road",
            elementType: "geometry",
            stylers: [
              { visibility: "simplified" },
              { lightness: 70 }
            ]
          },{
            featureType: "transit.line",
            stylers: [
              { visibility: "off" }
            ]
          },{
            featureType: "transit.station.bus",
            stylers: [
              { visibility: "off" }
            ]
          }
        ];
        
        var map_init = false;
        map = new google.maps.Map(document.getElementById("map_canvas"), {
            zoom: config.getParam('zoom_start'),
            center: config.getParam('center_start'),
            mapTypeId: google.maps.MapTypeId.ROADMAP,
            styles: mapStyles,
            disableDefaultUI: true,
            zoomControl: true,
            scaleControl: true,
            streetViewControl: true,
            overviewMapControl: true
        });
        
        map.setOptions({
            mapTypeControl: true,
            mapTypeControlOptions: {
                position: google.maps.ControlPosition.TOP_LEFT
            }
        });
        
        function map_layers_add(){
            var layer = null;
            layer = new google.maps.FusionTablesLayer({
                query: {
                    select: 'geometry',
                    from: config.getParam('ft_id_lines')
                },
                clickable: false,
                map: map,
                styles: [
                    {
                        polylineOptions: {
                            strokeColor: "#FF0000",
                            strokeWeight: 2
                        }
                    },{
                        where: "type = 'tunnel'",
                        polylineOptions: {
                            strokeColor: "#FAAFBE",
                            strokeWeight: 1.5
                        }
                    }
                ]
            });
            var stations_layer = new google.maps.FusionTablesLayer({
              query: {
                select: 'geometry',
                from: config.getParam('ft_id_stations')
              },
              clickable: false,
              map: map
            });
            layer = new google.maps.FusionTablesLayer({
              query: {
                select: 'geometry',
                from: config.getParam('ft_id_mask')
              },
              clickable: false,
              map: map
            });

            function trigger_toggleLayerVisibility() {
                function toggleLayerVisibility(layer, show) {
                    if (show) {
                        if (layer.getMap() === null) {
                            layer.setMap(map);
                        }
                    } else {
                        if (layer.getMap() !== null) {
                            layer.setMap(null);
                        }
                    }
                }

                var zoom = map.getZoom();
                toggleLayerVisibility(stations_layer, zoom >= 12);            
            }

            google.maps.event.addListener(map, 'idle', trigger_toggleLayerVisibility);
            trigger_toggleLayerVisibility();
        }
        
        google.maps.event.addListener(map, 'idle', function() {
            if (map_init === false) {
                // TODO - FIXME later ?
                // Kind of a hack, getBounds is ready only after a while since loading, so we hook in the 'idle' event
                map_layers_add();
                listener_helpers.notify('map_init');
                map_init = true;
            }
        });
        
        // SIMULATION PANEL
        var location_el = $('#user_location');
        location_el.attr('value-default', location_el.attr('value'));

        var geocoder = new google.maps.Geocoder();
        function geocoding_handle(params) {
            geocoder.geocode(params, function(results, status) {
                if (status === google.maps.GeocoderStatus.OK) {
                    location_el.val(results[0].formatted_address);
                    map.setCenter(results[0].geometry.location);
                    map.setZoom(15);
                }
            });
        }
        
        $('#geolocation_click').click(function(){
            if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(function (position) {
                    geocoding_handle({'latLng': new google.maps.LatLng(position.coords.latitude, position.coords.longitude)});
                });
            }
        });
        location_el.focus(function(){
            if ($(this).val() === $(this).attr('value-default')) {
                $(this).val('');
            }
        });
        location_el.keypress(function(e) {
            if(e.which === 13) {
                geocoding_handle({'address': $(this).val()});
            }
        });
        
        $('input.panel_collapsible').click(function() {
            var panel_content = $(this).closest('div[data-type="panel"]').children('div[data-type="panel-content"]');
            
            if ($(this).hasClass('expanded')) {
                $(this).removeClass('expanded');
                panel_content.addClass('hidden');
            } else {
                $(this).addClass('expanded');
                panel_content.removeClass('hidden');
            }
        });
    }
    
    listener_helpers.subscribe('map_init', function(){
        // Vehicle helpers
        // Roles:
        // - check backend for new vehicles
        // - manages vehicle objects(class Vehicle) and animates them (see Vehicle.render method)
        var vehicle_helpers = (function(){

            // Vehicle icons manager. 
            // Roles:
            // - keep a reference for each vehicle type (IC, ICE, etc..)
            var imagesPool = (function(){
                var icons = {};
                function iconGet(type) {
                    if (typeof icons[type] !== 'undefined') {
                        return icons[type];
                    }

                    var icon = new google.maps.MarkerImage(
                        'static/images/vehicle-types/' + type + '.png',
                         new google.maps.Size(20, 20),
                         new google.maps.Point(0, 0),
                         new google.maps.Point(10, 10)
                    );
                    icons[type] = icon;

                    return icon;
                }

                return {
                    iconGet: iconGet
                };
            })();

            var vehicle_ib = new InfoBox({
                disableAutoPan: true,
                pixelOffset: new google.maps.Size(10, 10),
                vehicle_id: 0,
                closeBoxURL: ''
            });

            var vehicleFollower = (function(){
                var track_vehicle_name = null;
                var vehicle_name_found = window.location.href.match(/vehicle_name=([^&]*)/);
                if (vehicle_name_found !== null) {
                    track_vehicle_name = decodeURIComponent(vehicle_name_found[1]).replace(/[^A-Z0-9]/i, '');
                }

                function isWaiting(id) {
                    if ($('#vehicle_info').attr('data-vehicle-id') !== id) {
                        return false;
                    }

                    if ($('#vehicle_info').attr('data-vehicle-follow') !== 'yes-init') {
                        return false;
                    }

                    return true;
                }

                function matchByName(name) {
                    if (track_vehicle_name === null) {
                        return false;
                    }

                    name = name.replace(/[^A-Z0-9]/i, '');
                    if (track_vehicle_name !== name) {
                        return false;
                    }

                    return true;
                }

                function setActive() {
                    $('#vehicle_info').attr('data-vehicle-follow', 'yes');
                }

                function isActive(id) {
                    if ($('#vehicle_info').attr('data-vehicle-id') !== id) {
                        return false;
                    }

                    if ($('#vehicle_info').attr('data-vehicle-follow') !== 'yes') {
                        return false;
                    }

                    return true;
                }

                var toggler = $('#follow_trigger');
                function toggle(stop_following) {
                    var toggler_value = 'Follow';
                    if (stop_following) {
                        $('#vehicle_info').attr('data-vehicle-follow', 'no');
                        toggler.removeClass('toggled');
                        map.unbind('center');
                    } else {
                        $('#vehicle_info').attr('data-vehicle-follow', 'yes-init');
                        toggler.addClass('toggled');
                        toggler_value = toggler.attr('data-value-toggle');
                    }

                    toggler.val(toggler_value);
                }
                toggler.click(function(){
                    toggle(toggler.hasClass('toggled'));
                });

                return {
                    isWaiting: isWaiting,
                    matchByName: matchByName,
                    setActive: setActive,
                    isActive: isActive,
                    toggle: toggle
                };
            })();

            $('#route_show_trigger').click(function(){
                if ($(this).hasClass('toggled')) {
                    $(this).removeClass('toggled');

                    linesPool.routeHighlightRemove();
                } else {
                    $(this).addClass('toggled');

                    var station_ids = $('#vehicle_info').attr('data-station-ids').split(',');
                    linesPool.routeHighlight(station_ids);
                }

                var value_new = $(this).attr('data-value-toggle');
                $(this).attr('data-value-toggle', $(this).val());
                $(this).val(value_new);
            });

            $('#vehicle_timetable tbody tr a').live('click', function(){
                var station_location = stationsPool.location_get($(this).attr('data-station-id'));
                if (parseInt(station_location.lng(), 10) === 0) { return; }

                map.setCenter(station_location);
                if (map.getZoom() < config.getParam('zoom_station')) {
                    map.setZoom(config.getParam('zoom_station'));
                }

                return false;
            });

            var vehicleIDs = [];

            function Vehicle(params) {
                var has_multiple_days = params.arrs[params.arrs.length - 1] > 24 * 3600;

                this.id             = params.id;
                this.stations       = params.sts;
                this.depS           = params.deps;
                this.arrS           = params.arrs;
                this.multiple_days  = has_multiple_days;

                var html_rows = [];
                $.each(params.edges, function(index, edges) {
                    var s_dep = (typeof params.deps[index] === 'undefined') ? 24 * 3600 : params.deps[index];

                    var html_row = '<tr data-dep-sec="' + s_dep + '"><td>' + (index + 1) + '.</td>';
                    html_row += '<td><a href="#station_id=' + params.sts[index] + '" data-station-id="' + params.sts[index] + '">' + stationsPool.get(params.sts[index]) + '</a></td>';
                    var hm_arr = (typeof params.arrs[index - 1] === 'undefined') ? '' : time_helpers.s2hm(params.arrs[index - 1]);
                    html_row += '<td>' + hm_arr + '</td>';
                    var hm_dep = (typeof params.deps[index] === 'undefined') ? '' : time_helpers.s2hm(params.deps[index]);
                    html_row += '<td>' + hm_dep + '</td></tr>';
                    html_rows.push(html_row);

                    if (index === 0) { return; }

                    if (linesPool.routeExists(params.sts[index-1], params.sts[index])) {
                        return;
                    }

                    linesPool.routeAdd(params.sts[index-1], params.sts[index], edges.split(','));
                });
                var timetables_rows = html_rows.join('');

                var marker = new google.maps.Marker({
                    position: new google.maps.LatLng(0, 0),
                    icon: imagesPool.iconGet(params.type),
                    map: null,
                    speed: 0,
                    status: 'not on map'
                });
                this.marker = marker;

                function vehicle_clickHandler() {
                    if ($('#vehicle_info').attr('data-vehicle-id') === params.id) {
                        return;
                    }

                    $('a.vehicle_name').text(params.name);

                    var hms = timer.getTime();
                    if (has_multiple_days && (hms < params.deps[0])) {
                        hms += 24 * 3600;
                    }

                    $('#vehicle_timetable > tbody').html(timetables_rows);
                    $('#vehicle_timetable tbody tr').each(function(){
                        if ($(this).attr('data-dep-sec') < hms) {
                            $(this).addClass('passed');
                        }
                    });

                    $('#vehicle_info').attr('data-vehicle-id', params.id);
                    $('#vehicle_info').attr('data-station-ids', params.sts.join(','));

                    $('#vehicle_info').removeClass('hidden');
                }
                google.maps.event.addListener(marker, 'click', function() {
                    vehicle_clickHandler();
                    vehicleFollower.toggle(true);
                });

                google.maps.event.addListener(marker, 'mouseover', function(){
                    if (map.getZoom() < config.getParam('zoom_mouseover_min')) {
                        return;
                    }

                    if (vehicle_ib.get('vehicle_id') === params.id) { return; }
                    vehicle_ib.set('vehicle_id', params.id);

                    vehicle_ib.close();

                    var popup_div = $('#vehicle_popup');
                    $('span.vehicle_name').text(params.name);
                    $('.status', popup_div).text(marker.get('status'));

                    vehicle_ib.setContent($('#vehicle_popup_container').html());
                    vehicle_ib.open(map, marker);
                });
                google.maps.event.addListener(marker, 'mouseout', function(){
                    vehicle_ib.set('vehicle_id', null);
                    vehicle_ib.close();
                });

                if (vehicleFollower.matchByName(params.name)) {
                    vehicle_clickHandler();
                    vehicleFollower.toggle(false);
                }
            }
            Vehicle.prototype.render = function() {
                var that = this;
                function animate() {
                    var hms = timer.getTime();
                    if (that.multiple_days && (hms < that.depS[0])) {
                        hms += 24 * 3600;
                    }

                    var vehicle_found = false;
                    for (var i=0; i<that.arrS.length; i++) {
                        if (hms < that.arrS[i]) {
                            var station_a = that.stations[i];
                            var station_b = that.stations[i+1];

                            var vehicle_position = null;

                            if (hms > that.depS[i]) {
                                // Vehicle is in motion between two stations
                                vehicle_found = true;
                                if (that.marker.get('speed') === 0) {
                                    var speed = linesPool.lengthGet(station_a, station_b) * 0.001 * 3600 / (that.arrS[i] - that.depS[i]);
                                    that.marker.set('speed', parseInt(speed, 10));

                                    that.marker.set('status', 'Heading to ' + stationsPool.get(station_b) + '(' + time_helpers.s2hm(that.arrS[i]) + ') with ' + that.marker.get('speed') + ' km/h');
                                }

                                var route_percent = (hms - that.depS[i])/(that.arrS[i] - that.depS[i]);

                                vehicle_position = linesPool.positionGet(station_a, station_b, route_percent);
                                if (vehicle_position === null) {
                                    console.log('Couldn\'t get the position of ' + that.id + ' between stations: ' + [station_a, station_b]);
                                    that.marker.setMap(null);
                                    break;
                                }
                            } else {
                                // Vehicle is in a station
                                vehicle_found = true;
                                that.marker.set('status', 'Departing ' + stationsPool.get(station_a) + ' at ' + time_helpers.s2hm(that.depS[i]));
                                that.marker.set('speed', 0);

                                vehicle_position = stationsPool.location_get(station_a);
                            }

                            if (map.getBounds().contains(vehicle_position)) {
                                if (that.marker.getMap() === null) {
                                    that.marker.setMap(map);
                                }
                                that.marker.setPosition(vehicle_position);
                            } else {
                                that.marker.setMap(null);
                            }

                            if (vehicleFollower.isWaiting(that.id)) {
                                vehicleFollower.setActive();

                                map.panTo(vehicle_position);
                                map.setZoom(config.getParam('zoom_follow'));
                                map.setMapTypeId('satellite');

                                map.bindTo('center', that.marker, 'position');
                            }

                            if (vehicleFollower.isActive(that.id)) {
                                // On mobile devices it might be that the followed vehicle 
                                //      to be out already of the map viewport.
                                //      So we bring it back :)
                                if (that.marker.getMap() === null) {
                                    map.panTo(vehicle_position);
                                }
                            }

                            setTimeout(animate, 1000);
                            break;
                        }
                    } // end arrivals loop

                    if (vehicle_found === false) {
                        that.marker.setMap(null);
                    }
                }

                animate();
            };

            return {
                load: function() {
                    $.ajax({
                        url: 'feed/vehicles/sbb/' + timer.getHM(),
                        dataType: 'json',
                        success: function(vehicles) {
                            $.each(vehicles, function(index, data) {
                                if (vehicleIDs.indexOf(data.id) !== -1) { return; }

                                var v = new Vehicle(data);
                                v.render();
                                vehicleIDs.push(data.id);
                            });
                        }
                    });
                }
            };
        })();
        
        // LOAD network lines 
        $.ajax({
            url: config.getParam('edges_path'),
            dataType: 'json',
            success: function(edges) {
                linesPool.loadEncodedEdges(edges);
                
                // network lines loaded => LOAD stations
                $.ajax({
                    url: 'feed/stations/sbb/list',
                    dataType: 'json',
                    success: function(stations_data) {
                        $.each(stations_data, function(index, station) {
                            stationsPool.add(parseInt(station.id, 10), station.name, parseFloat(station.x), parseFloat(station.y));
                        });

                        // Stations loaded => LOAD vehicles
                        vehicle_helpers.load();
                        setInterval(vehicle_helpers.load, 5*60*1000);
                    }
                });
            }
        });
    });
    
    return {
        subscribe: listener_helpers.subscribe,
        init: function(){
            timer.init();
            map_init();
        },
        getMap: function(){
            return map;
        }
    };
})();
    
$(document).ready(simulation_manager.init);
