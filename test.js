"use strict";
// load modules
var async = require("async");
var crypto = require("crypto");
var Redis = require("redis");

var rds = Redis.createClient();

// init express
var express = require("express");
var bodyParser = require('body-parser');
var app = express();
var jsonParser = bodyParser.json();

// init fitbit client
var FitbitApiClient = require("fitbit-node");
var	client = new FitbitApiClient(process.env.FITBIT_CLIENT_ID, process.env.FITBIT_SECERT);
var FITBITSCOPES = 'activity profile weight';

var saveToken = function( user_id, data, cb ){
	var _data = {
		access_token: data.access_token,
		refresh_token: data.refresh_token,
		user_id: data.user_id,
		fitbit_user: data.user_id,
		scope: data.scope,
		expire_ts: Date.now() + ( 1000 * data.expires_in )
	};
	
	rds.hset( "fitbit-subscription-example", user_id, JSON.stringify( _data ), function( err ){
		if( err ){
			cb( err );
			return;
		}
		console.log("SAVED TOKEN for user `" + user_id + "`");
		cb( null, _data.access_token );
	});
};

var getToken = function( user_id, cb ){
	rds.hget( "fitbit-subscription-example", user_id, function( err, resp ){
		if( err ){
			cb( err );
			return;
		}
		if( !resp ){
			cb( new Error( "ENOTFOUND" ) );
			return;
		}
		var _data = JSON.parse( resp );
		if( _data.expire_ts < Date.now() ){
			refreshToken( user_id, _data, cb );
			return;
		}
		cb( null, _data.access_token );
	});
};

var refreshToken = function( user_id, data, cb ){
	client.refreshAccesstoken( data.access_token, data.refresh_token )
	.then(function (refreshToken) {
		console.log("REFRESHED TOKEN", refreshToken );
		
		data.access_token = refreshToken;
		
		rds.hset( "fitbit-subscription-example", user_id, JSON.stringify( data ), function( err ){
			if( err ){
				cb( err );
				return;
			}
			console.log("SAVED REFRESHED TOKEN for user `" + user_id + "`");
			cb( null, data.access_token );
		});
	}).catch(function (error) {
		cb( error );
	});
};


// start here and open this route in your browser
app.get("/authorize/:user_id", function (req, res) {
	// pass a user id to the local user you want to connect
	var _uid = req.params.user_id;
	
	// generate teh authorize url
	var _url = client.getAuthorizeUrl(FITBITSCOPES, process.env.FITBIT_CALLBACK_URL );
	_url += "&state=" + req.params.user_id;
	
	console.log("AUTHORIZE USER", _uid);
	res.redirect(_url);
});

// add a callback url The url to this route should be public availible
app.get("/callback", function (req, res) {
	// as define in the authorize route the user id will be passed back through the state query
	var _uid = req.query.state;
	
	// get the access token to create a subscription by the oauth code
	var _code = req.query.code;

	client.getAccessToken( _code, process.env.FITBIT_CALLBACK_URL).then(function (result) {
		// save the access_token to redis to be later able to use it later
		saveToken( _uid, result, function( err, access_token ){
			if( err ){
				res.send(500, err);
			}
			
			// create the body subscription with the user id from the authorize route
			client.post("/body/apiSubscriptions/" + _uid + ".json", access_token ).then(function (results) {
				// grab the subscriptionId witch matches the user_id
				var user_id = results[0].subscriptionId;
				console.log("USER BODY SUBSCRIPTED for user `" + user_id + "`");
				
				// create the activities subscription with the user id from the authorize route
				client.post("/activities/apiSubscriptions/" + _uid + ".json", access_token ).then(function (results) {
					// grab the subscriptionId witch matches the user_id
					console.log("USER ACTIVITIES SUBSCRIPTED for user `" + user_id + "`");
					// return the user id
					res.send("USER: `"+ results[0].subscriptionId + "` CONNECTED");
				}).catch(function (error) {
					res.send(500, error);
				});

			}).catch(function (error) {
				res.send(500, error);
			});
		});
	}).catch(function (error) {
		res.send(500, error);
	});
});

// the webhook GET is the endpoint to verify the endpoint by the fitbit servers
app.get("/webhook", function (req, res) {
	if( req.query.verify === process.env.FITBIT_SUBSCRIPTION_VERIFY ){
		// should return 204 if the verify query matches
		console.log("WEBHOOK-VERIFY - OK");
		res.sendStatus( 204 );
	}else{
		// should return 404 if the code will not match
		console.log("WEBHOOK-VERIFY - Failed");
		res.sendStatus( 404 );
	}
});


// function used by async to receive the data of each subscription event
var readFitbitData = function( data, cb ){
	// grab the relevant data
	var user_id = data.subscriptionId; // your internal user
	var date = data.date; // the data date
	var fitbit_user = data.ownerId; // the fitbit user
	var type = data.collectionType; // the fitbit data type
	console.log("READFITBIT DATA `" + type + "` for user `" + user_id + "`" );
	
	// create the body subscription with the user id from the authorize route
	getToken( user_id, function( err, access_token ){
		if( err ){
			cb( err );
			return;
		}
		// create fitbit url based on type
		var _url = getFitbitUrl( type, { date: date } );
		client.get( _url, access_token, fitbit_user )
			.then(function (results) {
				console.log("RECEIVED CHANGED DATA `" + type + "` for user `" + user_id + "`", results[0] );
				cb( null );
			}).catch(function (error) {
				cb( error );
			});
		
	});
};

// this endpoint will receive the events from your subscribed users
app.post("/webhook", jsonParser, function (req, res) {
	console.log("WEBHOOK-DATA with " + req.body.length + " events");
	
	// check signature
	var fitbitSignature = req.headers[ "x-fitbit-signature" ];
	if( !testSignature( fitbitSignature, req.body ) ){
		console.log( "INVALID SIGNATURE" );
		res.sendStatus( 404 );
	}
	
	// loop through all events and read the data 
	async.eachLimit( req.body, 3, readFitbitData, function( err ){
		if( err ){
			console.log("WEBHOOK-DATA-ERROR", err);
		}else{
			console.log( "WEBHOOK-DATA PROCESSING DONE" );
		}
	});
	// the webhook should alway return a 204
	res.sendStatus( 204 );
});

// small helper function to create the fitbit url based on the webhook data collectionType 
var getFitbitUrl = function( type, data ){
	var _urls = {
		body: "/body/log/weight/date/[date].json",
		activities: "/activities/date/[date].json"
	};
	
	// replace the [key]'s with the passed data'
	if( _urls[ type ] ){
		var _url = _urls[ type ];
		var _k;
		for( _k in data ){
			_url = _url.replace( "["+_k+"]", data[ _k ] );
		}
		
		return _url;
	}
	console.error( "Type not found" );
	return null;
};

// check the fitbit webhook signature
var testSignature = function( sig, data ){
	var hmac = crypto.createHmac('sha1', process.env.FITBIT_SECERT+'&')
	hmac.update(JSON.stringify(data))
	if( sig === hmac.digest('base64') ){
		return true
	}else{
		return false
	}
}

app.listen(process.env.PORT || 8080);
