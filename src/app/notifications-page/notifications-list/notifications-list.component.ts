import { Component, OnInit } from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";
import * as _ from "lodash";
import { difference, isEmpty } from "lodash";
import { BsModalService } from "ngx-bootstrap/modal";
import { IAdapter, IDatasource } from "ngx-ui-scroll";
import { Subscription } from "rxjs";
import { InfiniteScroller } from "src/app/infinite-scroller";
import { TrackingService } from "src/app/tracking.service";
import { AppRoutingModule, RouteNames } from "../../app-routing.module";
import { BackendApiService, NFTEntryResponse, PostEntryResponse } from "../../backend-api.service";
import { GlobalVarsService } from "../../global-vars.service";
import { TransferNftAcceptModalComponent } from "../../transfer-nft-accept/transfer-nft-accept-modal/transfer-nft-accept-modal.component";

@Component({
  selector: "app-notifications-list",
  templateUrl: "./notifications-list.component.html",
  styleUrls: ["./notifications-list.component.scss"],
})
export class NotificationsListComponent implements OnInit {
  static BUFFER_SIZE = 10;
  static PAGE_SIZE = 50;
  static WINDOW_VIEWPORT = true;

  constructor(
    public globalVars: GlobalVarsService,
    private backendApi: BackendApiService,
    private modalService: BsModalService,
    private router: Router,
    private route: ActivatedRoute,
    private tracking: TrackingService
  ) {}

  // stores a mapping of page number to notification index
  pagedIndexes = {
    0: -1,
  };

  subscriptions = new Subscription();
  lastPage = null;
  loadingFirstPage = true;
  loadingNextPage = false;

  // stores a cache of all profiles and posts we've seen
  profileMap = {};
  postMap = {};

  // Track the total number of items for our empty state
  // null means we're loading items
  totalItems = null;
  totalFilteredItems = null;
  expandNotifications = true;

  showFilters = false;
  filteredOutSet = {};
  pauseVideos = false;

  readonly filteredOutOptions = ["like", "diamond", "transfer", "follow", "post", "nft"];
  readonly noFiltersSelectedOption = "none";

  ngOnInit() {
    const filterOutParamsFromQuery = this.queryToFilterOutParams(this.route.snapshot.queryParams.filter || "");
    const savedNotificationFilterPreferences = isEmpty(filterOutParamsFromQuery)
      ? this.backendApi.GetStorage("notificationFilterPreferences")
      : filterOutParamsFromQuery;

    const savedNotivicationViewPreference = this.backendApi.GetStorage("notificationViewPreference");
    this.expandNotifications = !_.isNil(savedNotivicationViewPreference) ? savedNotivicationViewPreference : true;
    this.filteredOutSet = savedNotificationFilterPreferences ? savedNotificationFilterPreferences : new Set();
    // Set this here, rather than calling a whole updateEverything call
    this.globalVars.unreadNotifications = 0;
  }

  ngOnDestroy() {
    // reset query params before leaving the page
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {},
    });
  }

  updateSettings(settings) {
    this.filteredOutSet = settings.filteredOutSet;
    this.expandNotifications = settings.expandNotifications;
    this.backendApi.SetStorage("notificationFilterPreferences", this.filteredOutSet);
    this.backendApi.SetStorage("notificationViewPreference", this.expandNotifications);

    const filterQuery = this.filterOutParamsToQuery(settings.filteredOutSet);

    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: filterQuery === "" ? {} : { filter: filterQuery },
    });

    this.scrollerReset();
  }

  scrollerReset() {
    this.loadingFirstPage = true;
    this.infiniteScroller.reset();
    this.datasource.adapter.reset().then(() => {
      this.datasource.adapter.check();
      this.loadingFirstPage = false;
    });
  }

  closeFilterMenu() {
    this.showFilters = false;
  }

  getPage(page: number, findingStartIndex: boolean = false) {
    if (this.lastPage && page > this.lastPage) {
      return [];
    }
    this.loadingNextPage = true;
    const fetchStartIndex = this.pagedIndexes[page];
    return this.backendApi
      .GetNotifications(
        "https://node.deso.org",
        this.globalVars.loggedInUser?.PublicKeyBase58Check,
        fetchStartIndex /*FetchStartIndex*/,
        NotificationsListComponent.PAGE_SIZE /*NumToFetch*/,
        this.filteredOutSet
      )
      .toPromise()
      .then(
        (res) => {
          // Only update the notifications metadata if loading the first page
          // If we're reading the notifications, we set unread notifications to 0,
          // and set the last unread notification index equal to the last read notification index
          if (fetchStartIndex === -1) {
            this.backendApi
              .SetNotificationsMetadata(
                "https://node.deso.org",
                this.globalVars.loggedInUser?.PublicKeyBase58Check,
                res.LastSeenIndex,
                res.LastSeenIndex,
                0
              )
              .toPromise();
          }

          // add all profiles and posts to our cache maps
          Object.assign(this.profileMap, res.ProfilesByPublicKey);
          Object.assign(this.postMap, res.PostsByHash);

          // Map all notifications to a format that is easy for our template to render
          // Filter out any null notifications we couldn't process

          const chunk = res.Notifications.map((notification) => this.transformNotification(notification)).filter(
            Boolean
          );

          // Index 0 means we're done. if the array is empty we're done.
          // subtract one so we don't fetch the last notification twice
          this.pagedIndexes[page + 1] = res.Notifications[res.Notifications.length - 1]?.Index - 1 || 0;

          // if the chunk was incomplete or the Index was zero we're done
          if (chunk.length < NotificationsListComponent.PAGE_SIZE || this.pagedIndexes[page + 1] === 0) {
            this.lastPage = page;
          }

          // Track the total number of items for our empty state
          this.totalItems = (this.totalItems || 0) + chunk.length;

          return chunk;
        },
        (err) => {
          console.error(this.backendApi.stringifyError(err));
        }
      )
      .finally(() => {
        this.loadingFirstPage = false;
        this.loadingNextPage = false;
      });
  }

  // NOTE: the outputs of this function are inserted directly into the DOM
  // using innerHTML. you MUST sanitize any user content that gets rendered. For example,
  // we sanitize post text and image URLs because they could contain HTML characters. We
  // don't sanitize numbers or usernames because they can't contain HTML characters.
  //
  // NOTE: We support rendering unfollows and unlikes but they're currently filtered
  // out by frontend_server's TxnMetaIsNotification
  protected transformNotification(notification: any) {
    const txnMeta = notification.Metadata;
    const userPublicKeyBase58Check = this.globalVars.loggedInUser?.PublicKeyBase58Check;

    if (txnMeta == null) {
      return null;
    }

    // The transactor is usually needed so parse her out and try to convert her
    // to a username.
    // TODO: make sure this map contains profiles from nft transfers
    const actor = this.profileMap[txnMeta.TransactorPublicKeyBase58Check] || {
      Username: "anonymous",
      ProfilePic: "/assets/img/default-profile-pic.png",
      PublicKeyBase58Check: txnMeta.TransactorPublicKeyBase58Check,
    };
    const userProfile = this.profileMap[userPublicKeyBase58Check];
    const actorName = actor.IsVerified
      ? `<b>${actor.Username}</b><span class="ml-1 d-inline-block align-center text-primary fs-12px"><i class="fas fa-check-circle fa-md align-middle"></i></span>`
      : `<b>${actor.Username}</b>`;

    // We map everything to an easy-to-use object so the template
    // doesn't have to do any hard work
    const result = {
      actor, // who created the notification
      category: null, // category used for filtering
      icon: null,
      iconClass: null,
      action: null, // the action they took
      actionDetails: null, // Summarized details of the action for compact mode
      post: null, // the post involved
      parentPost: null, // the parent post involved
      link: AppRoutingModule.profilePath(actor.Username),
      bidInfo: null,
      comment: null, // the text of the comment
      nftEntryResponses: null, // NFT Entry Responses, for transfers
    };

    if (txnMeta.TxnType === "BASIC_TRANSFER") {
      const basicTransferMeta = txnMeta.BasicTransferTxindexMetadata;
      if (!basicTransferMeta) {
        return null;
      }
      if (basicTransferMeta.DiamondLevel) {
        result.icon = "diamond";
        result.iconClass = "fc-blue";
        result.category = "diamond";
        let postText = "";
        if (basicTransferMeta.PostHashHex) {
          const truncatedPost = this.truncatePost(basicTransferMeta.PostHashHex);
          postText = `<i class="text-grey7">${truncatedPost}</i>`;
          result.link = AppRoutingModule.postPath(basicTransferMeta.PostHashHex);
        }
        result.action = `${actorName} gave <b>${basicTransferMeta.DiamondLevel.toString()} diamond${
          basicTransferMeta.DiamondLevel > 1 ? "s" : ""
        }</b> (~${this.globalVars.getUSDForDiamond(basicTransferMeta.DiamondLevel)}) ${postText}`;
      } else {
        let txnAmountNanos = 0;
        for (let ii = 0; ii < notification.TxnOutputResponses.length; ii++) {
          if (notification.TxnOutputResponses[ii]?.PublicKeyBase58Check === userPublicKeyBase58Check) {
            txnAmountNanos += notification.TxnOutputResponses[ii].AmountNanos;
          }
        }
        result.icon = "coin";
        result.iconClass = "fc-blue";
        result.category = "creator coin";
        result.action =
          `${actorName} sent you ${this.globalVars.nanosToDeSo(txnAmountNanos)} ` +
          `$DESO!</b> (~${this.globalVars.nanosToUSD(txnAmountNanos, 2)})`;
      }

      return result;
    } else if (txnMeta.TxnType === "CREATOR_COIN") {
      // If we don't have the corresponding metadata then return null.
      const ccMeta = txnMeta.CreatorCoinTxindexMetadata;
      if (!ccMeta) {
        return null;
      }

      result.icon = "coin";
      result.category = "creator coin";
      result.iconClass = "fc-blue";

      if (ccMeta.OperationType === "buy") {
        result.action = `${actorName} bought <b>~${this.globalVars.nanosToUSD(
          ccMeta.DeSoToSellNanos,
          2
        )}</b> worth of <a href="/${this.globalVars.RouteNames.USER_PREFIX}/${userProfile.Username}">@${
          userProfile.Username
        }</a>!`;
        return result;
      } else if (ccMeta.OperationType === "sell") {
        // TODO: We cannot compute the USD value of the sale without saving the amount of DeSo
        // that was used to complete the transaction in the backend, which we are too lazy to do.
        // So for now we just tell the user the amount of their coin that was sold.
        result.action = `${actorName} sold <b>${this.globalVars.nanosToDeSo(ccMeta.CreatorCoinToSellNanos)} $${
          userProfile.Username
        }.</b>`;
        return result;
      }
    } else if (txnMeta.TxnType === "CREATOR_COIN_TRANSFER") {
      const cctMeta = txnMeta.CreatorCoinTransferTxindexMetadata;
      if (!cctMeta) {
        return null;
      }

      if (cctMeta.DiamondLevel) {
        result.icon = "diamond";
        result.iconClass = "fc-blue";
        result.category = "diamond";
        let postText = "";
        if (cctMeta.PostHashHex) {
          const truncatedPost = this.truncatePost(cctMeta.PostHashHex);
          postText = `<i class="text-grey7">${truncatedPost}</i>`;
          result.link = AppRoutingModule.postPath(cctMeta.PostHashHex);
        }
        result.action = `${actorName} gave <b>${cctMeta.DiamondLevel.toString()} diamond${
          cctMeta.DiamondLevel > 1 ? "s" : ""
        }</b> (~${this.globalVars.getUSDForDiamond(cctMeta.DiamondLevel)}) ${postText}`;
      } else {
        result.icon = "send";
        result.category = "creator coin";
        result.iconClass = "fc-blue";
        result.action = `${actorName} sent you <b>${this.globalVars.nanosToDeSo(
          cctMeta.CreatorCoinToTransferNanos,
          6
        )} ${cctMeta.CreatorUsername} coins`;
      }

      return result;
    } else if (txnMeta.TxnType === "SUBMIT_POST") {
      const spMeta = txnMeta.SubmitPostTxindexMetadata;
      if (!spMeta) {
        return null;
      }

      // Grab the hash of the post that created this notification.
      const postHash = spMeta.PostHashBeingModifiedHex;

      // Go through the affected public keys until we find ours. Then
      // return a notification based on the Metadata.
      for (const currentPkObj of txnMeta.AffectedPublicKeys) {
        if (currentPkObj?.PublicKeyBase58Check !== userPublicKeyBase58Check) {
          continue;
        }

        // In this case, we are dealing with a reply to a post we made.
        if (currentPkObj.Metadata === "ParentPosterPublicKeyBase58Check") {
          result.icon = "message-square";
          result.category = "comment";
          result.iconClass = "fc-blue";
          const truncatedPost = this.truncatePost(spMeta.ParentPostHashHex);
          const postContent = `<i class="fc-muted">${truncatedPost}</i>`;
          const truncatedComment = this.truncatePost(postHash);
          const commentContent = `<i class="fc-muted">"${truncatedComment}"</i>`;
          const actionDetails = `${commentContent} ${postContent}`;
          result.action = `${actorName} replying to <a href="/${this.globalVars.RouteNames.USER_PREFIX}/${userProfile.Username}">@${userProfile.Username}</a>`;
          result.actionDetails = actionDetails;
          result.comment = this.postMap[postHash]?.Body;
          result.post = this.postMap[postHash];
          result.parentPost = this.postMap[spMeta.ParentPostHashHex];
          result.link = AppRoutingModule.postPath(postHash);
          if (result.post === null || result.parentPost === null) {
            return;
          }

          return result;
        } else if (currentPkObj.Metadata === "MentionedPublicKeyBase58Check") {
          result.icon = "message-square";
          result.category = "comment";
          result.iconClass = "fc-blue";
          const truncatedPost = this.truncatePost(postHash);
          const postContent = `<i class="fc-muted">${truncatedPost}</i>`;

          result.action = `${actorName} mentioned <a href="/${this.globalVars.RouteNames.USER_PREFIX}/${userProfile.Username}">@${userProfile.Username}</a>`;
          result.actionDetails = postContent;
          result.post = this.postMap[postHash];
          result.link = AppRoutingModule.postPath(postHash);
          if (result.post === null) {
            return;
          }

          return result;
        } else if (currentPkObj.Metadata === "RepostedPublicKeyBase58Check") {
          const post = this.postMap[postHash];
          result.icon = "repeat";
          result.category = "repost";
          result.iconClass = "fc-blue";
          const repostAction = post.Body === "" ? "Reposting" : "Quote reposting";
          const repostedPost = post.RepostedPostEntryResponse;
          const truncatedPost = _.truncate(_.escape(`${repostedPost.Body} ${repostedPost.ImageURLs?.[0] || ""}`));
          const repostedPostContent = `<i class="fc-muted">${truncatedPost}</i>`;
          // Repost
          result.link = AppRoutingModule.postPath(postHash);
          if (post.Body === "") {
            result.action = `${actorName} ${repostAction} <a href="/${this.globalVars.RouteNames.USER_PREFIX}/${userProfile.Username}">@${userProfile.Username}</a>`;
            result.actionDetails = repostedPostContent;
          } else {
            // Quote Repost
            const truncatedQuoteRepost = this.truncatePost(postHash);
            const quoteRepostContent = `<i class="fc-muted">"${truncatedQuoteRepost}"</i>`;
            result.action = `${actorName} ${repostAction} <a href="/${this.globalVars.RouteNames.USER_PREFIX}/${userProfile.Username}">@${userProfile.Username}</a>`;
            result.actionDetails = `${quoteRepostContent} ${repostedPostContent}`;
          }
          result.post = this.postMap[postHash];
          if (result.post === null) {
            return;
          }
          return result;
        }
      }
    } else if (txnMeta.TxnType === "FOLLOW") {
      const followMeta = txnMeta.FollowTxindexMetadata;
      if (!followMeta) {
        return null;
      }

      result.icon = "user";
      result.category = "follow";
      result.iconClass = "fc-blue";
      result.action = `${actorName} ${followMeta.IsUnfollow ? "un" : ""}followed you`;

      return result;
    } else if (txnMeta.TxnType === "LIKE") {
      const likeMeta = txnMeta.LikeTxindexMetadata;
      if (!likeMeta) {
        return null;
      }

      const postHash = likeMeta.PostHashHex;

      const postText = this.truncatePost(postHash);
      if (!postText) {
        return null;
      }
      const action = likeMeta.IsUnlike ? "unliked" : "liked";

      result.icon = likeMeta.IsUnlike ? "heart" : "heart";
      result.category = "like";
      result.iconClass = likeMeta.IsUnlike ? "fc-red" : "fc-red";
      result.action = `${actorName} ${action} <i class="text-grey7">${postText}</i>`;
      result.link = AppRoutingModule.postPath(postHash);

      return result;
    } else if (txnMeta.TxnType === "NFT_BID") {
      const nftBidMeta = txnMeta.NFTBidTxindexMetadata;
      if (!nftBidMeta) {
        return null;
      }

      const postHash = nftBidMeta.NFTPostHashHex;

      const actorName = actor.Username !== "anonymous" ? actor.Username : txnMeta.TransactorPublicKeyBase58Check;
      const truncatedPost = this.truncatePost(postHash);
      const postText = `<i class="fc-muted">${truncatedPost}</i>`;
      if (
        nftBidMeta.IsBuyNowBid &&
        this.globalVars.loggedInUser?.PublicKeyBase58Check === nftBidMeta.OwnerPublicKeyBase58Check
      ) {
        result.action = `${actorName} purchased serial number ${
          nftBidMeta.SerialNumber
        } for ${this.globalVars.nanosToDeSo(nftBidMeta.BidAmountNanos)} DESO ${postText}`;
      } else if (this.globalVars.loggedInUser?.PublicKeyBase58Check === nftBidMeta.OwnerPublicKeyBase58check) {
        result.action = nftBidMeta.BidAmountNanos
          ? `${actorName} bid ${this.globalVars.nanosToDeSo(
              nftBidMeta.BidAmountNanos,
              2
            )} DESO (~${this.globalVars.nanosToUSD(nftBidMeta.BidAmountNanos, 2)}) for serial number ${
              nftBidMeta.SerialNumber
            } ${postText}`
          : `${actorName} cancelled their bid on serial number ${nftBidMeta.SerialNumber} ${postText}`;
      } else {
        const additionalCoinRoyaltiesMap: { [k: string]: number } = nftBidMeta.AdditionalCoinRoyaltiesMap || {};
        const additionalDESORoyaltiesMap: { [k: string]: number } = nftBidMeta.AdditionalDESORoyaltiesMap || {};
        if (
          this.globalVars.loggedInUser?.PublicKeyBase58Check in additionalCoinRoyaltiesMap ||
          this.globalVars.loggedInUser?.PublicKeyBase58Check in additionalDESORoyaltiesMap
        ) {
          const additionalCoinRoyalty = additionalCoinRoyaltiesMap[this.globalVars.loggedInUser?.PublicKeyBase58Check];
          const coinRoyaltyStr = additionalCoinRoyalty
            ? `a royalty of ${this.globalVars.nanosToDeSo(additionalCoinRoyalty)} (~${this.globalVars.nanosToUSD(
                additionalCoinRoyalty,
                2
              )}) DESO to your creator coin`
            : "";
          const additionalDESORoyalty = additionalDESORoyaltiesMap[this.globalVars.loggedInUser?.PublicKeyBase58Check];
          const desoRoyaltyStr = additionalDESORoyalty
            ? `a royalty of ${this.globalVars.nanosToDeSo(additionalDESORoyalty)} (~${this.globalVars.nanosToUSD(
                additionalDESORoyalty,
                2
              )}) DESO to your wallet`
            : "";
          result.action = `${actor.Username} bought an NFT that generated ${desoRoyaltyStr}${
            desoRoyaltyStr && coinRoyaltyStr && " and "
          }${coinRoyaltyStr}`;
          result.icon = "dollar-sign";
          return result;
        } else {
          result.action = nftBidMeta.BidAmountNanos
            ? `${actorName} bid ${this.globalVars.nanosToDeSo(
                nftBidMeta.BidAmountNanos,
                2
              )} DESO (~${this.globalVars.nanosToUSD(nftBidMeta.BidAmountNanos, 2)}) for serial number ${
                nftBidMeta.SerialNumber
              } ${postText}`
            : `${actorName} cancelled their bid on serial number ${nftBidMeta.SerialNumber} ${postText}`;
        }
      }
      result.icon = "coin";
      result.category = "nft";
      result.iconClass = nftBidMeta.BidAmountNanos ? "fc-blue" : "fc-red";
      result.bidInfo = { SerialNumber: nftBidMeta.SerialNumber, BidAmountNanos: nftBidMeta.BidAmountNanos };
      result.link = AppRoutingModule.nftPath(postHash);
      return result;
    } else if (txnMeta.TxnType == "ACCEPT_NFT_BID") {
      const acceptNFTBidMeta = txnMeta.AcceptNFTBidTxindexMetadata;
      if (!acceptNFTBidMeta) {
        return null;
      }

      const postHash = acceptNFTBidMeta.NFTPostHashHex;

      result.post = this.postMap[postHash];

      const additionalCoinRoyaltiesMap: { [k: string]: number } = acceptNFTBidMeta.AdditionalCoinRoyaltiesMap || {};
      const additionalDESORoyaltiesMap: { [k: string]: number } = acceptNFTBidMeta.AdditionalDESORoyaltiesMap || {};
      if (
        this.globalVars.loggedInUser?.PublicKeyBase58Check in additionalCoinRoyaltiesMap ||
        this.globalVars.loggedInUser?.PublicKeyBase58Check in additionalDESORoyaltiesMap
      ) {
        const additionalCoinRoyalty = additionalCoinRoyaltiesMap[this.globalVars.loggedInUser?.PublicKeyBase58Check];
        const coinRoyaltyStr = additionalCoinRoyalty
          ? `a royalty of ${this.globalVars.nanosToDeSo(additionalCoinRoyalty)} (~${this.globalVars.nanosToUSD(
              additionalCoinRoyalty
            )}) to your creator coin`
          : "";
        const additionalDESORoyalty = additionalDESORoyaltiesMap[this.globalVars.loggedInUser?.PublicKeyBase58Check];
        const desoRoyaltyStr = additionalDESORoyalty
          ? `a royalty of ${this.globalVars.nanosToDeSo(additionalDESORoyalty)} (~${this.globalVars.nanosToUSD(
              additionalDESORoyalty
            )}) to your wallet`
          : "";
        result.action = `${actor.Username} accepted a bid on an NFT that generated ${desoRoyaltyStr}${
          desoRoyaltyStr && coinRoyaltyStr && " and "
        }${coinRoyaltyStr}`;
      } else {
        result.action = `${actor.Username} accepted your bid of ${this.globalVars.nanosToDeSo(
          acceptNFTBidMeta.BidAmountNanos,
          2
        )} for serial number ${acceptNFTBidMeta.SerialNumber}`;
        result.bidInfo = {
          SerialNumber: acceptNFTBidMeta.SerialNumber,
          BidAmountNanos: acceptNFTBidMeta.BidAmountNanos,
        };
      }

      result.icon = "award";
      result.category = "nft";
      result.iconClass = "fc-blue";
      result.link = AppRoutingModule.nftPath(postHash);
      return result;
    } else if (txnMeta.TxnType == "NFT_TRANSFER") {
      const nftTransferMeta = txnMeta.NFTTransferTxindexMetadata;
      if (!nftTransferMeta) {
        return null;
      }

      const postHash = nftTransferMeta.NFTPostHashHex;
      // TODO: Fix backend response for profiles returned from NFT transfer notifications
      if (actor.Username === "annonymous") {
        this.backendApi
          .GetSingleProfile(this.globalVars.localNode, txnMeta.TransactorPublicKeyBase58Check, "")
          .subscribe((user) => {
            if (user?.Profile?.Username) {
              const actorName =
                user.Profile.Username !== "anonymous" ? user.Profile.Username : txnMeta.TransactorPublicKeyBase58Check;
              result.action = `${actorName} transferred an NFT to you`;
              result.actor = user.Profile;
              result.post.ProfileEntryResponse = user.Profile;
            }
          });
      }
      const actorName = actor.Username !== "anonymous" ? actor.Username : txnMeta.TransactorPublicKeyBase58Check;
      result.post = this.postMap[postHash];
      if (_.isNil(result.post.ProfileEntryResponse)) {
        result.post.ProfileEntryResponse = result.actor;
      }
      result.action = `${actorName} transferred an NFT to you`;
      result.icon = "send";
      result.category = "nft";
      result.iconClass = "fc-blue";
      result.link = AppRoutingModule.nftPath(postHash);
      this.backendApi
        .GetNFTEntriesForNFTPost(
          this.globalVars.localNode,
          this.globalVars.loggedInUser?.PublicKeyBase58Check,
          result.post.PostHashHex
        )
        .subscribe((res) => {
          const transferNFTEntryResponses = _.filter(res.NFTEntryResponses, (nftEntryResponse: NFTEntryResponse) => {
            return (
              nftEntryResponse.OwnerPublicKeyBase58Check === this.globalVars.loggedInUser?.PublicKeyBase58Check &&
              nftEntryResponse.IsPending
            );
          });

          result.nftEntryResponses = transferNFTEntryResponses;
        });
      return result;
    } else if (txnMeta.TxnType === "CREATE_NFT") {
      const createNFTMeta = txnMeta.CreateNFTTxindexMetadata;
      if (!createNFTMeta) {
        return null;
      }
      createNFTMeta.AdditionalDESORoyaltiesMap = createNFTMeta.AdditionalDESORoyaltiesMap || {};
      createNFTMeta.AdditionalCoinRoyaltiesMap = createNFTMeta.AdditionalCoinRoyaltiesMap || {};
      const additionalCoinRoyalty =
        createNFTMeta.AdditionalCoinRoyaltiesMap[this.globalVars.loggedInUser?.PublicKeyBase58Check];
      const coinRoyaltyStr = additionalCoinRoyalty
        ? `a royalty of ${additionalCoinRoyalty / 100}% to your creator coin`
        : "";
      const additionalDESORoyalty =
        createNFTMeta.AdditionalDESORoyaltiesMap[this.globalVars.loggedInUser?.PublicKeyBase58Check];
      const desoRoyaltyStr = additionalDESORoyalty ? `a royalty of ${additionalDESORoyalty / 100}% to your wallet` : "";
      if (!coinRoyaltyStr && !desoRoyaltyStr) {
        return null;
      }
      result.action = `${actorName} minted an NFT and gave ${desoRoyaltyStr}${
        coinRoyaltyStr && desoRoyaltyStr && " and "
      }${coinRoyaltyStr}`;
      result.category = "nft";
      result.iconClass = "fc-blue";
      result.icon = "percent";
      result.post = this.postMap[createNFTMeta.NFTPostHashHex];
      return result;
    } else if (txnMeta.TxnType === "UPDATE_NFT") {
      const updateNFTMeta = txnMeta.UpdateNFTTxindexMetadata;
      if (!updateNFTMeta || !updateNFTMeta.IsForSale) {
        return null;
      }
      result.post = this.postMap[updateNFTMeta.NFTPostHashHex];
      result.category = "nft";
      result.iconClass = "fc-blue";
      result.icon = "tag";
      if (result.post.PosterPublicKeyBase58Check === this.globalVars.loggedInUser?.PublicKeyBase58Check) {
        result.action = `${actorName} put your NFT on sale`;
        return result;
      } else {
        const additionalDESORoyaltiesMap = result.post.AdditionalDESORoyaltiesMap || {};
        const additionalCoinRoyaltiesMap = result.post.AdditionalCoinRoyaltiesMap || {};
        const additionalCoinRoyalty = additionalCoinRoyaltiesMap[this.globalVars.loggedInUser?.PublicKeyBase58Check];
        const coinRoyaltyStr = additionalCoinRoyalty
          ? `a royalty of ${additionalCoinRoyalty / 100}% to your creator coin`
          : "";
        const additionalDESORoyalty = additionalDESORoyaltiesMap[this.globalVars.loggedInUser?.PublicKeyBase58Check];
        const desoRoyaltyStr = additionalDESORoyalty
          ? `a royalty of ${additionalDESORoyalty / 100}% to your wallet`
          : "";
        if (!coinRoyaltyStr && !desoRoyaltyStr) {
          return null;
        }
        result.action = `${actorName} put an NFT on sale - you receive ${desoRoyaltyStr}${
          desoRoyaltyStr && coinRoyaltyStr && " and "
        }${coinRoyaltyStr} on the sale`;
        return result;
      }
    } else if (txnMeta.TxnType === "DAO_COIN") {
      const coinMeta = txnMeta.DAOCoinTxindexMetadata;
      if (!coinMeta) {
        return null;
      }
      switch (coinMeta.OperationType) {
        case "mint": {
          const amount = this.globalVars.hexNanosToStandardUnit(coinMeta.CoinsToMintNanos);
          const amountFormatted = this.globalVars.abbreviateNumber(amount, 4, false);

          result.action = `minted ${amountFormatted} ${coinMeta.CreatorUsername} ${this.globalVars.pluralize(
            amount,
            "coin"
          )}`;
          result.icon = "fas fa-coins fc-green";
          return result;
        }
        case "burn": {
          const amount = this.globalVars.hexNanosToStandardUnit(coinMeta.CoinsToBurnNanos);
          const amountFormatted = this.globalVars.abbreviateNumber(amount, 4, false);

          result.action = `${actorName} burned ${amountFormatted} ${
            coinMeta.CreatorUsername
          } ${this.globalVars.pluralize(amount, "coin")}`;
          result.icon = "fa fa-fire fc-red";
          return result;
        }
        case "disable_minting": {
          result.action = `${actorName} disabled minting for ${coinMeta.CreatorUsername} coin`;
          result.icon = "fas fa-minus-circle fc-red";
          return result;
        }
        case "update_transfer_restriction_status": {
          result.action = `${actorName} updated the transfer restriction status of ${coinMeta.CreatorUsername} coin to ${coinMeta.TransferRestrictionStatus}`;
          result.icon = "fas fa-pen-fancy";
          return result;
        }
      }
      return null;
    } else if (txnMeta.TxnType === "DAO_COIN_TRANSFER") {
      const coinTransferMeta = txnMeta.DAOCoinTransferTxindexMetadata;
      const amount = this.globalVars.hexNanosToStandardUnit(coinTransferMeta.DAOCoinToTransferNanos);
      const amountFormatted = this.globalVars.abbreviateNumber(amount, 6, false);

      if (!coinTransferMeta) {
        return null;
      }
      result.icon = "fas fa-money-bill-wave fc-blue";
      result.action = `${actorName} sent you <b>${amountFormatted} ${
        coinTransferMeta.CreatorUsername
      } ${this.globalVars.pluralize(amount, "coin")}`;
      return result;
    }

    // If we don't recognize the transaction type we return null
    return null;
  }

  truncatePost(postHashHex: any): string | null {
    const post = this.postMap[postHashHex];
    if (!post) {
      return null;
    }
    return _.truncate(_.escape(`${post.Body} ${post.ImageURLs?.[0] || ""}`));
  }

  pauseAllVideos(isPaused) {
    this.pauseVideos = isPaused;
  }

  acceptTransfer(event, notification) {
    event.stopPropagation();
    this.tracking.log("nft-accept-button : click");
    if (!this.globalVars.isMobile()) {
      this.pauseAllVideos(true);
      const modalDetails = this.modalService.show(TransferNftAcceptModalComponent, {
        class: "modal-dialog-centered modal-lg",
        initialState: {
          post: notification.post,
          transferNFTEntryResponses: notification.nftEntryResponses,
        },
      });
      const onHideEvent = modalDetails.onHide;
      onHideEvent.subscribe(() => {
        this.pauseAllVideos(false);
      });
    } else {
      this.router.navigate(["/" + RouteNames.TRANSFER_NFT_ACCEPT + "/" + notification.post.PostHashHex], {
        queryParamsHandling: "merge",
        state: {
          post: notification.post,
          postHashHex: notification.post.PostHashHex,
          transferNFTEntryResponses: notification.nftEntryResponses,
        },
      });
    }
  }

  async afterCommentCallback(uiParent, index, newComment) {
    const uiPostParentHashHex = this.globalVars.getPostContentHashHex(uiParent.post);
    await this.datasource.adapter.relax();
    await this.datasource.adapter.update({
      predicate: ({ $index, data, element }) => {
        let currentNotification = data as any;
        if ($index === index) {
          newComment.parentPost = currentNotification.post;
          currentNotification.post.Comments = currentNotification.post.Comments || [];
          currentNotification.post.Comments.unshift(_.cloneDeep(newComment));
          currentNotification.post = this.globalVars.incrementCommentCount(currentNotification.post);
          return [currentNotification];
        } else if (
          currentNotification.post &&
          this.globalVars.getPostContentHashHex(currentNotification.post) === uiPostParentHashHex
        ) {
          // We also want to increment the comment count on any other notifications related to the same post hash hex.
          currentNotification.post = this.globalVars.incrementCommentCount(currentNotification.post);
          return [currentNotification];
        }
        // Leave all other items in the datasource as is.
        return true;
      },
    });
  }

  private filterOutParamsToQuery(filterOutSet: { [notificationType: string]: boolean }) {
    const keys = Object.keys(filterOutSet);
    const diff = difference(this.filteredOutOptions, keys);

    if (diff.length === 0) {
      // no filters selected
      return this.noFiltersSelectedOption;
    }

    if (diff.length === this.filteredOutOptions.length) {
      // all filters selected, returning empty string to omit the query param
      return "";
    }

    // return only selected filters
    return difference(this.filteredOutOptions, keys).join(",");
  }

  private queryToFilterOutParams(routeQuery: string) {
    const selectedFilters = routeQuery.split(",");
    const diff = difference(this.filteredOutOptions, selectedFilters);

    if (diff.length === this.filteredOutOptions.length && routeQuery !== this.noFiltersSelectedOption) {
      // no specific filters defined in route query (no param at all, or all filters are enabled)
      return {};
    }

    // return only non-selected filters
    return diff.reduce((acc, key) => ({ ...acc, [key]: true }), {});
  }

  infiniteScroller: InfiniteScroller = new InfiniteScroller(
    NotificationsListComponent.PAGE_SIZE,
    this.getPage.bind(this),
    NotificationsListComponent.WINDOW_VIEWPORT,
    NotificationsListComponent.BUFFER_SIZE
  );
  datasource: IDatasource<IAdapter<PostEntryResponse>> = this.infiniteScroller.getDatasource();
}
