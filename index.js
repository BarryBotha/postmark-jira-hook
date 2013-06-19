var express = require('express');
var request = require('request');
var _ = require('underscore');
var async = require('async');
var natural = require('natural');
var tokenizer = new natural.WordTokenizer();
var multipart = require('multipart');
var S = require('string');
var moment = require('moment');

function htmlEscape(str) {
    return String(str)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
}

function htmlUnescape(value){
    return String(value)
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

var base_url = 'https://digitalprodevelopment.atlassian.net';

var base_settings = {

	rejectUnauthorized: true,
	followAllRedirects: true,

	'auth': {
		'user': process.env.JIRA_USER or '',
		'pass': process.env.JIRA_PASSWORD or '',
		'sendImmediately': true
	}

};

var app = express();

app.configure(function(){

	app.use(express.bodyParser());
	app.use(express.methodOverride());

	app.use(app.router);

});


app.get('/', function(req,res){

	// Redirect to digitalpro homepage
	res.redirect('http://www.digitalpro.co.za');

});

app.head('/jira/issues', function(req, res) {res.send('ok');});
app.get('/jira/issues', function(req, res) {res.send('ok');});

app.post('/jira/issues', function(req, res){

	if(req.body.webhookEvent && req.body.webhookEvent == 'jira:issue_updated' && req.body.comment) {

		// Only E-Mails
		if('' + req.body.issue.fields.issuetype.id == '9') {

			var splits = req.body.issue.fields.summary.split('-');

			var user_name = req.body.comment.author.name;
			var user_email = req.body.comment.author.emailAddress;
			var body = req.body.comment.body;
			var created = req.body.comment.created;
			var lastupdated = req.body.comment.lastupdated;
			var issue_key = req.body.issue.key;
			var to = S(splits[splits.length-1]).trim().s;
			var project_key = issue_key.split('-')[0]

			var subject = '*' + req.body.issue.key + '* - ' + req.body.issue.fields.summary.split('-')[0];

			var mu = require('mu2');
			mu.root = __dirname;
			mu.compileAndRender(__dirname + '/email_template.html', {

				from_name: user_name,
				from_email: user_email,
				to: to,
				body: body,
				subject: subject,
				key: issue_key,
				project_key: project_key,
				created: moment(created).format('LLL'),
				lastupdated: moment(lastupdated).format('LLL')

			}).on('data', function (data) {

				console.dir(data);

				var template_body = data.toString();

				console.dir(template_body);

				// Send with Postmark
				console.log(user_name + " - " + subject + "-" + body + " -- " + moment(created).format('LLL'));
				console.log();

				var postmark = require("postmark")(process.env.POSTMARK_API);
			    postmark.send({

			        "From": "support@digitalpro.co.za", 
			        "To": to, 
			        "Subject": subject, 
			        "HtmlBody": template_body

			    });

				res.send('ok');

			});

		}

	} else res.send('ok');

});

app.head('/emails/received', function(req, res) {res.send('ok');});
app.get('/emails/received', function(req, res) {res.send('ok');});

app.post('/emails/received', function(req, res){

	console.dir(req.body);

	var from_email = req.body.FromFull.Email;
	var from_name = req.body.FromFull.Name;
	var to_email = req.body.To;
	var cc_email = req.body.Cc;

	var from_name_str = from_email;

	/* if(S(from_name).isEmpty() == false) {

		from_name_str = from_name + " <" + from_email + ">";
  
	} */

	var subject = (req.body.Subject || '') + " - " + from_name_str;
	var body = req.body.TextBody || req.body.HtmlBody || '';

	body = '{html}' + htmlUnescape(body) + '{html}';
	// body = S(body).stripTags().s;

	var msg_body = body;
	
	var attachments = req.body.Attachments;

	request( _.extend(base_settings, {

		uri: base_url + '/rest/api/2/project/',
		method: 'GET',

	}), function(err, response_obj, body_obj){

		console.dir(body_obj);

		projects = JSON.parse(body_obj);
		var issue_keys = [];

		matching_project = _.find(projects, function(project_obj){

			var subject_str = subject.toLowerCase();
			var tokens = tokenizer.tokenize(subject_str);

			return project_obj && project_obj.key && tokens.indexOf('*' + project_obj.key.toLowerCase() + '*') != -1;

		});

		// Ok but does this match a key in that project ?
		var issue_keys = subject.match(/(\w+)-(\d+)/g);

		if(issue_keys && _.size(issue_keys) > 0) {

			async.each(issue_keys, function(issue_key, callback){

				request.post( _.extend(base_settings, {

					url: base_url + '/rest/api/2/issue/' + issue_key + '/comment',
					json: {

						body: msg_body + '\r\n\r\n' + 'From ' + from_name_str

					},
					method: 'POST',

				}), function(err, response, body){

					console.dir([err, body]);

					callback();

				});

			}, function(err){

				res.send('ok');

			});

		} else {

			var project_key = 'SE';
			if(matching_project) project_key = matching_project.key;

			var email_params_to_send = {

				'fields': {

					"project":
			       { 
			          "key": project_key
			       },
			       "summary": subject,
			       "description": body,
			       "issuetype": {

			       	"name": "E-Mail"

			       }

				}

			};

			request.post( _.extend(base_settings, {

				url: base_url + '/rest/api/2/issue/',
				json: email_params_to_send,
				method: 'POST',

			}), function(err, response_obj, body_obj){

				console.dir(body_obj);

				var issue_key = body_obj.key;

				// Upload any attachments if any !
				if(attachments && attachments.length > 0) {

					async.each(attachments, function(attachment_obj, callback){

						r_obj = { 

							'_attachments': {}

						};

						r_obj['_attachments'][attachment_obj.Name] = {
							'follows': true,
							'content_type': attachment_obj.ContentType
						};

						request.post( _.extend(base_settings, {

							url: base_url + '/rest/api/2/issue/' + issue_key + '/attachments',
							headers: {

								'X-Atlassian-Token':'nocheck'

							},
							multipart: [ 

								{
									'content-type': 'application/json', 
									body: JSON.stringify(r_obj)
								}, 
								{ 
									body: new Buffer(attachment_obj.Content, 'base64')
								}
							] 

						}), function(err, response, body){

							console.dir([err, body]);

							callback();

						});

					}, function(err){

						res.send('done!');

					});

				} else {

					res.send('done!');

				}

			});

		}

	});

});

var port = process.env.PORT || 5000;

app.listen(port, function(){

	console.log('listening on port ' + port);

});



