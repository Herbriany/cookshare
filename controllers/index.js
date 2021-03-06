const User = require('../models/user');
const Post = require('../models/post');
const passport = require('passport');
const fixerToken = process.env.FIXER_API_KEY;
const mapBoxToken = process.env.MAPBOX_TOKEN;
const util = require('util');
const { cloudinary } = require('../cloudinary');
const { deleteProfileImage } = require('../middleware');
const crypto = require('crypto');
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
// Set your secret key. Remember to switch to your live secret key in production!
// See your keys here: https://dashboard.stripe.com/account/apikeys
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const currencies = require('../currencies');
const fetch = require("node-fetch");

module.exports = {

  async landingPage(req, res, next) {
    const posts = await Post.find({}).sort('-_id').exec();
    const recentPosts = posts.slice(0, 3);

    res.render('index', { posts, mapBoxToken, recentPosts,  title: 'Cookshare - Home' });
  },

  getRegister(req, res, next) {
    res.render('register.ejs', { title: 'Register', username: '', email: '' } )
  },

  async postRegister(req, res, next) {
    try {
      if (req.file) {
        const { secure_url, public_id } = req.file;
        req.body.image = {
          secure_url,
          public_id
        }
      }
      const user = await User.register(new User(req.body), req.body.password);
      req.login(user, function(err) {
        if (err) return next(err);
        req.session.success = `You successfully logged in ${user.username}!` 
        res.redirect('/');
      });
    }
    catch(err) {
      deleteProfileImage(req);
      const { username, email } = req.body;
      let error = err.message;
      if (error.includes('duplicate') && error.includes('index: email_1 dup key')) {
        error = 'A user with the given email is already registered';
      }
      res.render('register', {title: 'Register', username, email, error });
    }
  },

  getLogin(req, res, next) {
    if (req.isAuthenticated()) return res.redirect('/');
    if (req.query.returnTo) req.session.redirectTo = req.headers.referer;
    res.render('login.ejs', { title: 'Login' } )
  },

  async postLogin(req, res, next) {
    const { username, password} = req.body; 
    const { user, error } = await User.authenticate()(username, password);
    if (!user && error) return next(error);
    req.login(user, function(err) {
      if (err) return next(err);
      req.session.success = `Welcome back ${username}`;
      const redirectUrl = req.session.redirectTo || '/';
      delete req.session.redirectTo;
      res.redirect(redirectUrl);
    });
  },

  getLogout(req, res, next) {
      req.logout();
      req.session.success = 'Successfully logged out!'
      res.redirect('/');
  },

  async getProfile (req, res, next) {
    const posts = await Post.find().where('author').equals(req.user._id).sort('-_id').limit(3).exec();
    res.render('profile', { posts });
  },

  async updateProfile (req, res, next) {
    const {
      username,
      email,
      currency
    } = req.body;
    const { user } = res.locals;
    if (username) user.username = username;
    if (email) user.email = email;
    if (currency) user.currency = currency;
    if (req.file) {
      if (user.image.public_id) await cloudinary.v2.uploader.destroy(user.image.public_id);
      const { secure_url, public_id } = req.file;
      user.image = { secure_url, public_id };
    }
    await user.save();
    const login = util.promisify(req.login.bind(req));
    await login(user);
    req.session.success = 'Profile successfully updated';
    res.redirect('/profile');
  },

  getForgotPw (req, res, next) {
    res.render('users/forgot');
  },

  async putForgotPw (req, res, next) {
    const token = await crypto.randomBytes(20).toString('hex');
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      req.session.error = 'No user with this email exists';
      return res.redirect('/forgot-password');
    }
    user.resetPasswordToken = token;
    user.resetPasswordExpires = Date.now() + 7200000;
    await user.save();
    const msg = {
      to: email,
      from: 'Cookshare admin <brian_derrig@hotmail.co.uk>',
      subject: 'Cookshare - Forgot/reset Password',
      text: `You are recieving this because you (or someone else) have requested the reset of the password of your account.
      Please click on the following link, or copy and past it into your browser to complete the process:
      http://${req.headers.host}/reset/${token}
      If you did not request this please ignore the email and your passord will remain unchanged`.replace(/      /g, ''),
      
    };
    await sgMail.send(msg);
    req.session.success = `An email has been sent to ${email} with further instructions`;
    console.log(msg)
    res.redirect('/forgot-password');
  },

  async getReset (req, res, next) {
    const { token } = req.params;
    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() }
    });

    if (!user) {
      req.session.error = 'Reset password token is invalid or expired mate';
      return res.redirect('/forgot-password');
    }

    res.render('users/reset', { token });
  },

  async putReset (req, res, next) {
    const { token } = req.params;
    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() }
    });

    if (!user) {
      req.session.error = 'Reset password token is invalid or expired';
      return res.redirect('/forgot-password');
    }

    if (req.body.password === req.body.confirm) {
      await user.setPassword(req.body.password);
      user.resetPasswordToken = null;
      user.resetPasswordExpires = null;
      await user.save();
      const login = util.promisify(req.login.bind(req));
      await login(user);
    }
    else {
      req.session.error = 'Passwords do not match';
      return res.redirect(`/reset/${ token }`);
    }

    const msg = {
      to: user.email,
      from: 'Cookshare admin <brian_derrig@hotmail.co.uk>',
      subject: 'Cookshare - Password Changed',
      text: `Hello ${user.username}
      Your password has successfully been changed.
      If you did not request this change please hit reply and notify us at once`.replace(/      /g, ''),
    };
    await sgMail.send(msg)
    req.session.success = 'Password successfully updated'
    res.redirect('/');
  },

  async getCheckout (req, res, next) {
    
    try {
      const post = await Post.findById(req.query.post);
      if (post.amount <=0 ) {
        req.session.error = 'This product is currently sold out';
        return res.redirect('back');
      }
      // convert currency if currentUser and post currencies are different
      var newPrice;
      var symbol = currencies[req.user.currency]['symbol_native'];

      if (req.user.currency !== post.currency) {
          await fetch(`http://data.fixer.io/api/latest?access_key=${fixerToken}&symbols=${req.user.currency},${post.currency}&format=1`)
          .then(response => {
              if (response.ok) {
                  return response.json();
              }
              else {
                  req.session.error = 'Error retrieving posts';
                  return res.redirect('/');
              }
          })
          .then(result =>{
              let postCurrency = result.rates[post.currency];
              let currentUserCurrency = result.rates[req.user.currency];
              let convertedCurrencyFloat = ((currentUserCurrency/postCurrency)*post.price);
              newPrice = convertedCurrencyFloat.toFixed(currencies[req.user.currency]['decimal_digits']);
          })
      }
      else {
          newPrice = post.price.toFixed(currencies[post.currency]['decimal_digits']);
      }
      
      res.render('checkout', { post, symbol, newPrice, title: 'Post Checkout' } )
    }
    catch {
      req.session.error = 'This post does not exist';
      res.redirect('/posts')
    }
  },

  async postPay (req, res, next) {
    const { paymentMethodId, items, currency } = req.body;
    const post = await Post.findById(req.headers.post);
    try {
      // Create new PaymentIntent with a PaymentMethod ID from the client.
      const intent = await stripe.paymentIntents.create({
        amount: (post.price * 100),
        currency: post.currency,
        payment_method: paymentMethodId,
        error_on_requires_action: true,
        confirm: true
      });
  
      console.log("💰 Payment received!");
      // You can add any post-payment code here (e.g. shipping, fulfillment, etc)
      // Send the client secret to the client to use in the demo
      res.send({ clientSecret: intent.client_secret });
    } catch (e) {
      if (e.code === "authentication_required") {
        res.send({
          error:
            "This card requires authentication in order to proceed. Please use a different card."
        });
      } else {
        res.send({ error: e.message });
      }
    }
  },

  async getPaid (req, res, next) {
    try{
      const post = await Post.findById(req.query.post);
      const newPrice = req.cookies.price;
      const symbol = currencies[req.user.currency]['symbol_native'];
      res.clearCookie('price')
      post.amount -= 1;
      await post.save();
      res.render('paid', { post, newPrice, symbol } );
    }
    catch {
      req.session.error = 'This post does not exist';
      res.redirect('/posts')
    }
  },
}
